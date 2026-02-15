/**
 * 游戏Socket服务 - 实时数据同步
 */
import { io, Socket } from 'socket.io-client';
import { SERVER_BASE } from './api';

const isLoopbackHostname = (hostname: string): boolean => {
  const h = String(hostname || '').trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
};

const normalizeBaseUrl = (raw: string): string => {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/\/+$/, '');
};

const resolveGameSocketUrl = (): string => {
  const fromEnv = normalizeBaseUrl((import.meta.env.VITE_SOCKET_URL as string | undefined) ?? '');
  const fromApi = normalizeBaseUrl(SERVER_BASE);

  if (typeof window === 'undefined' || !window.location) {
    return fromEnv || fromApi || 'http://localhost:6011';
  }

  const protocol = window.location.protocol || 'http:';
  const hostname = window.location.hostname;

  // 生产环境使用同域名，开发环境使用 6011 端口
  const isDev = isLoopbackHostname(hostname);
  const runtimeDefault = isDev
    ? `${protocol}//${hostname}:6011`
    : `${protocol}//${hostname}`;

  const base = fromEnv || fromApi || runtimeDefault;

  try {
    const url = new URL(base);
    if (isLoopbackHostname(url.hostname) && !isLoopbackHostname(hostname)) {
      url.hostname = hostname;
      return normalizeBaseUrl(url.toString());
    }
    return normalizeBaseUrl(url.toString());
  } catch {
    if (base.startsWith('/')) return normalizeBaseUrl(`${window.location.origin}${base}`);
    return base;
  }
};

const GAME_SOCKET_URL = resolveGameSocketUrl();

// 角色属性接口
export interface CharacterData {
  id: number;
  userId: number;
  nickname: string;
  title: string;
  gender: string;
  avatar: string | null;
  autoCastSkills: boolean;
  autoDisassembleEnabled: boolean;
  spiritStones: number;
  silver: number;
  stamina: number;
  realm: string;
  subRealm: string | null;
  exp: number;
  attributePoints: number;
  jing: number;
  qi: number;
  shen: number;
  attributeType: string;
  attributeElement: string;
  qixue: number;
  maxQixue: number;
  lingqi: number;
  maxLingqi: number;
  wugong: number;
  fagong: number;
  wufang: number;
  fafang: number;
  mingzhong: number;
  shanbi: number;
  zhaojia: number;
  baoji: number;
  baoshang: number;
  kangbao: number;
  zengshang: number;
  zhiliao: number;
  jianliao: number;
  xixue: number;
  lengque: number;
  shuxingShuzhi: number;
  kongzhiKangxing: number;
  jinKangxing: number;
  muKangxing: number;
  shuiKangxing: number;
  huoKangxing: number;
  tuKangxing: number;
  qixueHuifu: number;
  lingqiHuifu: number;
  sudu: number;
  fuyuan: number;
  currentMapId: string;
  currentRoomId: string;
}

type CharacterListener = (character: CharacterData | null) => void;
type ErrorListener = (error: { message: string }) => void;
type KickedListener = (data: { message: string }) => void;
type TeamUpdateListener = (data: unknown) => void;
type BattleUpdateListener = (data: unknown) => void;
type ArenaUpdateListener = (data: unknown) => void;
export type ChatChannel = 'world' | 'team' | 'sect' | 'private' | 'battle';

export interface ChatMessageDto {
  id: string;
  clientId?: string;
  channel: ChatChannel;
  content: string;
  timestamp: number;
  senderUserId: number;
  senderCharacterId: number;
  senderName: string;
  senderTitle: string;
  pmTargetCharacterId?: number;
}

type ChatMessageListener = (message: ChatMessageDto) => void;
type ChatErrorListener = (error: { message: string }) => void;

export interface OnlinePlayerDto {
  id: number;
  nickname: string;
  title: string;
  realm: string;
}

export interface OnlinePlayersPayloadDto {
  total: number;
  players: OnlinePlayerDto[];
}

type OnlinePlayersListener = (payload: OnlinePlayersPayloadDto) => void;

class GameSocketService {
  private socket: Socket | null = null;
  private characterListeners: Set<CharacterListener> = new Set();
  private errorListeners: Set<ErrorListener> = new Set();
  private kickedListeners: Set<KickedListener> = new Set();
  private teamUpdateListeners: Set<TeamUpdateListener> = new Set();
  private battleUpdateListeners: Set<BattleUpdateListener> = new Set();
  private arenaUpdateListeners: Set<ArenaUpdateListener> = new Set();
  private chatMessageListeners: Set<ChatMessageListener> = new Set();
  private chatErrorListeners: Set<ChatErrorListener> = new Set();
  private onlinePlayersListeners: Set<OnlinePlayersListener> = new Set();
  private currentCharacter: CharacterData | null = null;
  private currentOnlinePlayers: OnlinePlayersPayloadDto | null = null;
  private isConnected = false;

  // 连接游戏服务器
  connect(): void {
    const token = localStorage.getItem('token');
    if (!token) {
      if (this.socket) this.disconnect();
      console.warn('未登录，无法连接游戏服务器');
      return;
    }

    if (this.socket) {
      if (this.socket.connected) return;
      this.socket.connect();
      return;
    }

    this.socket = io(GAME_SOCKET_URL, { path: '/game-socket', transports: ['websocket', 'polling'], autoConnect: false });

    this.socket.on('connect', () => {
      console.log('游戏服务器已连接');
      this.isConnected = true;
      // 发送认证
      const latestToken = localStorage.getItem('token');
      if (latestToken) this.socket?.emit('game:auth', latestToken);
    });

    this.socket.on('disconnect', () => {
      console.log('游戏服务器已断开');
      this.isConnected = false;
      this.currentOnlinePlayers = null;
    });

    this.socket.on('game:character', (data: { character: CharacterData | null }) => {
      this.currentCharacter = data.character;
      this.notifyCharacterListeners(data.character);
    });

    this.socket.on('game:error', (error: { message: string }) => {
      console.error('游戏错误:', error.message);
      this.notifyErrorListeners(error);
    });

    // 被踢出处理
    this.socket.on('game:kicked', (data: { message: string }) => {
      console.warn('被踢出:', data.message);
      this.notifyKickedListeners(data);
    });

    this.socket.on('team:update', (data: unknown) => {
      this.notifyTeamUpdateListeners(data);
    });
    
    this.socket.on('battle:update', (data: unknown) => {
      this.notifyBattleUpdateListeners(data);
    });

    this.socket.on('arena:update', (data: unknown) => {
      this.notifyArenaUpdateListeners(data);
    });

    this.socket.on('chat:message', (data: ChatMessageDto) => {
      if (!data || typeof data !== 'object') return;
      this.notifyChatMessageListeners(data);
    });

    this.socket.on('chat:error', (error: { message: string }) => {
      this.notifyChatErrorListeners(error);
    });

    this.socket.on('game:onlinePlayers', (payload: unknown) => {
      const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
      const toStringSafe = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
      const toNumberSafe = (v: unknown): number | null => {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') {
          const s = v.trim();
          if (!s) return null;
          const n = Number(s);
          return Number.isFinite(n) ? n : null;
        }
        return null;
      };

      if (!isRecord(payload)) return;
      const totalRaw = toNumberSafe(payload.total);
      const playersRaw = Array.isArray(payload.players) ? payload.players : [];
      const players: OnlinePlayerDto[] = [];

      for (const item of playersRaw) {
        if (!isRecord(item)) continue;
        const id = toNumberSafe(item.id);
        if (!id || id <= 0) continue;
        const nickname = toStringSafe(item.nickname).trim();
        if (!nickname) continue;
        const title = toStringSafe(item.title).trim();
        const realm = toStringSafe(item.realm).trim();
        players.push({ id, nickname, title, realm });
      }

      this.currentOnlinePlayers = { total: totalRaw ?? players.length, players };
      this.notifyOnlinePlayersListeners(this.currentOnlinePlayers);
    });

    this.socket.connect();
  }

  // 断开连接
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
      this.currentCharacter = null;
      this.currentOnlinePlayers = null;
    }
  }

  // 请求刷新角色数据
  refreshCharacter(): void {
    if (this.socket?.connected) {
      this.socket.emit('game:refresh');
    }
  }

  // 加点请求
  addPoint(attribute: 'jing' | 'qi' | 'shen', amount: number = 1): void {
    if (this.socket?.connected) {
      this.socket.emit('game:addPoint', { attribute, amount });
    }
  }

  // 订阅角色数据变化
  onCharacterUpdate(listener: CharacterListener): () => void {
    this.characterListeners.add(listener);
    // 立即发送当前数据
    if (this.currentCharacter) {
      listener(this.currentCharacter);
    }
    return () => this.characterListeners.delete(listener);
  }

  // 订阅错误
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  // 订阅被踢出事件
  onKicked(listener: KickedListener): () => void {
    this.kickedListeners.add(listener);
    return () => this.kickedListeners.delete(listener);
  }

  onTeamUpdate(listener: TeamUpdateListener): () => void {
    this.teamUpdateListeners.add(listener);
    return () => this.teamUpdateListeners.delete(listener);
  }
  
  onBattleUpdate(listener: BattleUpdateListener): () => void {
    this.battleUpdateListeners.add(listener);
    return () => this.battleUpdateListeners.delete(listener);
  }

  onArenaUpdate(listener: ArenaUpdateListener): () => void {
    this.arenaUpdateListeners.add(listener);
    return () => this.arenaUpdateListeners.delete(listener);
  }

  onChatMessage(listener: ChatMessageListener): () => void {
    this.chatMessageListeners.add(listener);
    return () => this.chatMessageListeners.delete(listener);
  }

  onChatError(listener: ChatErrorListener): () => void {
    this.chatErrorListeners.add(listener);
    return () => this.chatErrorListeners.delete(listener);
  }

  onOnlinePlayersUpdate(listener: OnlinePlayersListener): () => void {
    this.onlinePlayersListeners.add(listener);
    if (this.currentOnlinePlayers) {
      listener(this.currentOnlinePlayers);
    } else if (this.socket?.connected) {
      this.socket.emit('game:onlinePlayers:request');
    }
    return () => this.onlinePlayersListeners.delete(listener);
  }

  requestOnlinePlayers(): void {
    if (!this.socket?.connected) return;
    this.socket.emit('game:onlinePlayers:request');
  }

  sendChatMessage(payload: {
    channel: ChatChannel;
    content: string;
    clientId: string;
    pmTargetCharacterId?: number;
  }): void {
    if (!this.socket?.connected) return;
    this.socket.emit('chat:send', payload);
  }

  // 获取当前角色数据
  getCharacter(): CharacterData | null {
    return this.currentCharacter;
  }

  updateCharacterLocal(patch: Partial<CharacterData>): void {
    if (!this.currentCharacter) return;
    const entries = Object.entries(patch) as Array<[keyof CharacterData, CharacterData[keyof CharacterData] | undefined]>;
    if (entries.length === 0) return;

    const assignCharacterField = <K extends keyof CharacterData>(target: CharacterData, key: K, value: CharacterData[K]) => {
      target[key] = value;
    };

    let changed = false;
    const nextCharacter: CharacterData = { ...this.currentCharacter };
    for (const [key, nextValue] of entries) {
      if (nextValue === undefined) continue;
      const prevValue = this.currentCharacter[key];
      if (Object.is(prevValue, nextValue)) continue;
      assignCharacterField(nextCharacter, key, nextValue as CharacterData[typeof key]);
      changed = true;
    }

    if (!changed) return;
    this.currentCharacter = nextCharacter;
    this.notifyCharacterListeners(nextCharacter);
  }

  // 是否已连接
  isSocketConnected(): boolean {
    return this.isConnected;
  }

  private notifyCharacterListeners(character: CharacterData | null): void {
    this.characterListeners.forEach((listener) => listener(character));
  }

  private notifyErrorListeners(error: { message: string }): void {
    this.errorListeners.forEach((listener) => listener(error));
  }

  private notifyKickedListeners(data: { message: string }): void {
    this.kickedListeners.forEach((listener) => listener(data));
  }

  private notifyTeamUpdateListeners(data: unknown): void {
    this.teamUpdateListeners.forEach((listener) => listener(data));
  }
  
  private notifyBattleUpdateListeners(data: unknown): void {
    this.battleUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyArenaUpdateListeners(data: unknown): void {
    this.arenaUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyChatMessageListeners(message: ChatMessageDto): void {
    this.chatMessageListeners.forEach((listener) => listener(message));
  }

  private notifyChatErrorListeners(error: { message: string }): void {
    this.chatErrorListeners.forEach((listener) => listener(error));
  }

  private notifyOnlinePlayersListeners(payload: OnlinePlayersPayloadDto): void {
    this.onlinePlayersListeners.forEach((listener) => listener(payload));
  }
}

// 单例
export const gameSocket = new GameSocketService();

export default gameSocket;
