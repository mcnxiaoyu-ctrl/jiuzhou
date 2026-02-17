import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireCharacter, getOptionalUserId } from '../middleware/auth.js';
import { getEnabledMaps, getMapDefById, getRoomInMap, getRoomsInMap, getWorldMap } from '../services/mapService.js';
import { getAreaObjects, getRoomObjects, gatherRoomResource, pickupRoomItem } from '../services/roomObjectService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();

router.get('/world', async (_req: Request, res: Response) => {
  try {
    const data = await getWorldMap();
    res.json({ success: true, data });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/area/:area/objects', async (req: Request, res: Response) => {
  try {
    const areaParam = req.params.area;
    const area = (Array.isArray(areaParam) ? areaParam[0] : areaParam) as Parameters<typeof getAreaObjects>[0];
    const objects = await getAreaObjects(area);
    res.json({ success: true, data: { area, objects } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/maps', async (_req: Request, res: Response) => {
  try {
    const maps = await getEnabledMaps();
    res.json({ success: true, data: { maps } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/:mapId', async (req: Request, res: Response) => {
  try {
    const mapIdParam = req.params.mapId;
    const mapId = Array.isArray(mapIdParam) ? mapIdParam[0] : mapIdParam;
    const map = await getMapDefById(mapId);
    if (!map || map.enabled !== true) {
      res.status(404).json({ success: false, message: '地图不存在' });
      return;
    }
    const rooms = await getRoomsInMap(mapId);
    res.json({ success: true, data: { map, rooms } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/:mapId/rooms/:roomId', async (req: Request, res: Response) => {
  try {
    const mapIdParam = req.params.mapId;
    const roomIdParam = req.params.roomId;
    const mapId = Array.isArray(mapIdParam) ? mapIdParam[0] : mapIdParam;
    const roomId = Array.isArray(roomIdParam) ? roomIdParam[0] : roomIdParam;
    const room = await getRoomInMap(mapId, roomId);
    if (!room) {
      res.status(404).json({ success: false, message: '房间不存在' });
      return;
    }
    res.json({ success: true, data: { mapId, room } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/:mapId/rooms/:roomId/objects', async (req: Request, res: Response) => {
  try {
    const mapIdParam = req.params.mapId;
    const roomIdParam = req.params.roomId;
    const mapId = Array.isArray(mapIdParam) ? mapIdParam[0] : mapIdParam;
    const roomId = Array.isArray(roomIdParam) ? roomIdParam[0] : roomIdParam;
    const userId = getOptionalUserId(req);
    const objects = await getRoomObjects(mapId, roomId, userId);
    res.json({ success: true, data: { mapId, roomId, objects } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.post('/:mapId/rooms/:roomId/resources/:resourceId/gather', requireCharacter, async (req: Request, res: Response) => {
  try {
    const mapIdParam = req.params.mapId;
    const roomIdParam = req.params.roomId;
    const resourceIdParam = req.params.resourceId;
    const mapId = Array.isArray(mapIdParam) ? mapIdParam[0] : mapIdParam;
    const roomId = Array.isArray(roomIdParam) ? roomIdParam[0] : roomIdParam;
    const resourceId = Array.isArray(resourceIdParam) ? resourceIdParam[0] : resourceIdParam;
    const userId = req.userId!;
    const characterId = req.characterId!;

    const result = await gatherRoomResource({ mapId, roomId, resourceId, userId, characterId });

    const didGain = Boolean(result.success && result.data && typeof result.data.qty === 'number' && result.data.qty > 0);
    if (didGain) {
      await safePushCharacterUpdate(userId);
    }

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.post('/:mapId/rooms/:roomId/items/:itemDefId/pickup', requireCharacter, async (req: Request, res: Response) => {
  try {
    const mapIdParam = req.params.mapId;
    const roomIdParam = req.params.roomId;
    const itemDefIdParam = req.params.itemDefId;
    const mapId = Array.isArray(mapIdParam) ? mapIdParam[0] : mapIdParam;
    const roomId = Array.isArray(roomIdParam) ? roomIdParam[0] : roomIdParam;
    const itemDefId = Array.isArray(itemDefIdParam) ? itemDefIdParam[0] : itemDefIdParam;
    const userId = req.userId!;
    const characterId = req.characterId!;

    const result = await pickupRoomItem({ mapId, roomId, itemDefId, userId, characterId });

    const didGain = Boolean(result.success && result.data && typeof result.data.qty === 'number' && result.data.qty > 0);
    if (didGain) {
      await safePushCharacterUpdate(userId);
    }

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

export default router;
