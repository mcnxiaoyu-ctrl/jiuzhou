#!/usr/bin/env python3
"""
作用：
1) 从 ModelScope 下载并加载 `AI-ModelScope/RMBG-2.0` 模型（命中缓存时不重复下载）。
2) 对输入图片执行本地背景移除，输出带 alpha 通道的 PNG。

不做什么：
1) 不处理批量目录任务，仅处理单张输入图。
2) 不做网络接口调用或回退到第三方抠图服务。
3) 不做额外兜底重试，任一关键步骤失败直接抛错并退出。

输入 / 输出：
- 输入参数：
  * --input-path: 待抠图图片路径（必填）
  * --output-path: 输出 PNG 路径（必填）
  * --model-id: ModelScope 模型 ID（默认 AI-ModelScope/RMBG-2.0）
  * --cache-dir: ModelScope 缓存目录（默认 ~/.cache/modelscope）
  * --device: 推理设备 auto/cpu/cuda（默认 auto）
- 输出：
  * 在 --output-path 写入 RGBA PNG 图片

数据流：
1) 解析参数 -> 2) snapshot_download 拉取模型到本地缓存 ->
3) transformers 加载模型 -> 4) 图像预处理 ->
5) 前向推理得到 mask -> 6) 合成 alpha 并输出 PNG。

关键边界条件与坑点：
1) `--device=cuda` 时若当前机器不可用 CUDA，会直接报错，避免静默降级导致结果不可预期。
2) 模型输出结构可能是多层 list/tuple，必须取最后一级 logits 才能正确得到前景 mask。
3) 输出目录可能不存在，写文件前需要显式创建父目录。
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional
from modelscope import snapshot_download
from PIL import Image
from torchvision import transforms
from transformers import AutoModelForImageSegmentation


DEFAULT_MODEL_ID = "AI-ModelScope/RMBG-2.0"
DEFAULT_CACHE_DIR = "~/.cache/modelscope"
DEFAULT_DEVICE = "auto"
MODEL_INPUT_SIZE = (1024, 1024)
NORMALIZE_MEAN = [0.485, 0.456, 0.406]
NORMALIZE_STD = [0.229, 0.224, 0.225]

# 前景 mask 收边参数（逐格抠图场景使用保守收边，避免把小件主体抠断）
MASK_FOREGROUND_OFFSET = 0.03
MASK_FOREGROUND_SCALE = 0.97
MASK_GAMMA = 1.05


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="RMBG-2.0 本地抠图脚本")
    parser.add_argument("--input-path", required=True, help="输入图片路径")
    parser.add_argument("--output-path", required=True, help="输出 PNG 路径")
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID, help="ModelScope 模型 ID")
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR, help="ModelScope 缓存目录")
    parser.add_argument(
        "--device",
        default=DEFAULT_DEVICE,
        choices=["auto", "cpu", "cuda"],
        help="推理设备：auto/cpu/cuda",
    )
    return parser.parse_args()


def resolve_device(device_arg: str) -> str:
    """
    解析并校验推理设备。

    规则：
    1) auto: 优先 cuda，不可用则 cpu。
    2) cuda: 必须保证 torch.cuda.is_available()，否则直接报错。
    3) cpu: 固定 cpu。
    """
    if device_arg == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"

    if device_arg == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("参数错误：请求使用 CUDA，但当前环境未检测到可用 CUDA 设备。")

    return device_arg


def extract_mask_tensor(model_output: object) -> torch.Tensor:
    """
    从 RMBG 模型输出中提取并融合二维 mask（0~1）。

    设计说明：
    1) RMBG-2.0 会返回多尺度输出；在“整图一次抠图”时低分辨率分支有补偿价值，
       但在“逐格抠图”场景里，低分辨率分支更容易引入块状外扩（白底盘/白边残留）。
    2) 因此这里仅使用最高分辨率分支作为主 mask，再做轻量收边，优先保证边界干净和主体完整。
    3) 最终统一返回 shape = [H, W] 的单通道张量。
    """
    def collect_tensors(value: object, bucket: list[torch.Tensor]) -> None:
        """递归收集输出中的 Tensor。"""
        if isinstance(value, torch.Tensor):
            bucket.append(value)
            return
        if isinstance(value, (list, tuple)):
            for item in value:
                collect_tensors(item, bucket)

    tensors: list[torch.Tensor] = []
    collect_tensors(model_output, tensors)
    if len(tensors) == 0:
        raise RuntimeError("模型输出错误：未得到 Tensor 类型的前景预测结果。")

    normalized_masks: list[torch.Tensor] = []
    normalized_mask_areas: list[int] = []
    target_height = 0
    target_width = 0
    max_area = -1

    for tensor in tensors:
        if tensor.ndim == 4:
            # [B, C, H, W] -> 取 batch0 + channel0
            mask = tensor[:1, :1, :, :]
        elif tensor.ndim == 3:
            # [B, H, W] -> 补 channel 维度
            mask = tensor[:1, :, :].unsqueeze(1)
        else:
            continue

        height = int(mask.shape[-2])
        width = int(mask.shape[-1])
        area = height * width
        if area > max_area:
            max_area = area
            target_height = height
            target_width = width

        normalized_masks.append(torch.sigmoid(mask))
        normalized_mask_areas.append(area)

    if len(normalized_masks) == 0 or target_height <= 0 or target_width <= 0:
        raise RuntimeError("模型输出错误：未得到可用的二维前景 mask。")

    upsampled_masks: list[torch.Tensor] = []
    for mask in normalized_masks:
        resized = functional.interpolate(
            mask,
            size=(target_height, target_width),
            mode="bilinear",
            align_corners=False,
        )
        upsampled_masks.append(resized)

    # 以最高分辨率输出作为主 mask，可显著减少块状外扩与白边。
    high_resolution_masks = [
        mask for mask, area in zip(upsampled_masks, normalized_mask_areas) if area == max_area
    ]
    high_resolution_mask = high_resolution_masks[-1]

    # 仅保留高分辨率主 mask，并做轻量前景压缩，减少白边同时避免细节被过度侵蚀。
    refined = torch.clamp(
        (high_resolution_mask - MASK_FOREGROUND_OFFSET) / MASK_FOREGROUND_SCALE,
        min=0.0,
        max=1.0,
    ) ** MASK_GAMMA

    return refined[0, 0].detach().cpu().clamp(0.0, 1.0)


def run_local_rmbg(
    input_path: Path,
    output_path: Path,
    model_id: str,
    cache_dir: Path,
    device: str,
) -> None:
    """
    执行本地 RMBG 抠图主流程。

    输入：
    - input_path: 原始图片路径
    - output_path: 输出 PNG 路径
    - model_id: ModelScope 模型 ID
    - cache_dir: 模型缓存目录
    - device: 已解析设备（cpu/cuda）

    输出：
    - 将 RGBA PNG 写入 output_path
    """
    model_dir = snapshot_download(model_id=model_id, cache_dir=str(cache_dir))

    model = AutoModelForImageSegmentation.from_pretrained(model_dir, trust_remote_code=True)
    model.to(device)
    model.eval()

    transform_image = transforms.Compose(
        [
            transforms.Resize(MODEL_INPUT_SIZE),
            transforms.ToTensor(),
            transforms.Normalize(NORMALIZE_MEAN, NORMALIZE_STD),
        ]
    )

    source_rgb = Image.open(input_path).convert("RGB")
    source_size = source_rgb.size
    input_tensor = transform_image(source_rgb).unsqueeze(0).to(device)

    with torch.no_grad():
        prediction = model(input_tensor)

    mask_tensor = extract_mask_tensor(prediction)
    mask_np = (mask_tensor.numpy() * 255.0).astype(np.uint8)

    alpha_mask = Image.fromarray(mask_np, mode="L").resize(source_size, Image.Resampling.BILINEAR)
    result = source_rgb.convert("RGBA")
    result.putalpha(alpha_mask)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path, format="PNG")


def main() -> None:
    """CLI 入口。"""
    args = parse_args()
    input_path = Path(args.input_path).expanduser().resolve()
    output_path = Path(args.output_path).expanduser().resolve()
    cache_dir = Path(args.cache_dir).expanduser().resolve()
    model_id = str(args.model_id).strip()
    device = resolve_device(str(args.device).strip().lower())

    if not input_path.is_file():
        raise RuntimeError(f"输入文件不存在：{input_path}")
    if not model_id:
        raise RuntimeError("参数错误：model_id 不能为空。")

    run_local_rmbg(
        input_path=input_path,
        output_path=output_path,
        model_id=model_id,
        cache_dir=cache_dir,
        device=device,
    )


if __name__ == "__main__":
    main()
