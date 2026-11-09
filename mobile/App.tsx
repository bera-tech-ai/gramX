import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Modal,
  Switch,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
} from 'react-native';
import { io, Socket } from 'socket.io-client';
import { mediaDevices, RTCPeerConnection, RTCIceCandidate, RTCSessionDescription, RTCView } from './webrtc';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
const BRAND = '#42B4FF';
const BRAND_DARK = '#1678C8';
const BG = '#050818';
const PANEL = '#0D1A38';
const PANEL_RAISED = '#12234A';
const MUTED = '#8D9AB8';
const LINE = '#1D3159';
const GREEN = '#4CE095';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function registerForPushNotificationsAsync() {
  if (Platform.OS === 'web') return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('calls', {
      name: 'Voice calls',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const permissions = await Notifications.getPermissionsAsync();
  let status = permissions.status;
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

type Session = { username: string; token: string; role?: 'user' | 'admin' };
type Profile = { username: string; displayName?: string; avatar?: string; customAvatar?: string | null };
type Conversation = {
  partner: string;
  profile?: Profile;
  lastMessage?: { text?: string; timestamp?: string; sender?: string };
  unread?: number;
};
type StatusItem = { _id: string; user: string; text: string; timestamp: string; bg?: string; image?: string | null; hasImage?: boolean; viewedByMe?: boolean; likedByMe?: boolean; viewCount?: number; likeCount?: number };
type Group = { _id: string; name: string; members?: string[]; lastMessage?: { text?: string; timestamp?: string }; unreadCount?: number };
type UserSettings = { displayName?: string; about?: string; notifications?: boolean; sound?: boolean; privacy?: { readReceipts?: boolean; lastSeen?: string } };
type Message = {
  _id?: string;
  tempId?: string;
  sender: string;
  receiver?: string;
  groupId?: string;
  text?: string;
  timestamp?: string;
  pending?: boolean;
  image?: string | null;
  audio?: string | null;
  audioDuration?: number;
  edited?: boolean;
  deleted?: boolean;
  reactions?: Record<string, string>;
  starred?: boolean;
  pinned?: boolean;
  pinnedBy?: string | null;
  pinnedAt?: string | null;
  read?: boolean;
  delivered?: boolean;
  oneView?: boolean;
};

type AppTab = 'chats' | 'status' | 'calls' | 'contacts' | 'settings' | 'admin';
type CallState = { callId: string; peer: string; role: 'caller' | 'callee'; type: 'voice' | 'video'; state: 'ringing' | 'connecting' | 'connected'; incoming?: boolean };
type CallRecord = { caller: string; callee: string; type: 'voice' | 'video'; status: string; durationSec: number; startedAt: string };

type SocketReply<T> = { success: boolean; error?: string } & T;

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return (await response.json()) as T;
}

function toDataUrl(asset: { base64?: string | null; mimeType?: string | null }) {
  return asset.base64 ? `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}` : null;
}

function initials(name: string) {
  return name.slice(0, 1).toUpperCase();
}

function Avatar({ name, initials: initialProp, small = false, size, accent = BRAND, ring = false }: { name?: string; initials?: string; small?: boolean; size?: number; accent?: string; ring?: boolean }) {
  const dimension = size || (small ? 38 : 48);
  return <View style={{ width: dimension + (ring ? 8 : 0), height: dimension + (ring ? 8 : 0), borderRadius: dimension, borderWidth: ring ? 2 : 0, borderColor: accent, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: dimension, height: dimension, borderRadius: dimension, backgroundColor: `${accent}2B`, borderWidth: 1, borderColor: LINE, alignItems: 'center', justifyContent: 'center' }}><Text style={[styles.avatarText, { color: accent, fontSize: dimension * 0.34 }]}>{initialProp || initials(name || '?')}</Text></View></View>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<Profile[]>([]);
  const [statuses, setStatuses] = useState<StatusItem[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [callHistory, setCallHistory] = useState<CallRecord[]>([]);
  const [activeGroup, setActiveGroup] = useState<Group | null>(null);
  const [groupMessages, setGroupMessages] = useState<Message[]>([]);
  const [settings, setSettings] = useState<UserSettings>({ notifications: true, sound: true, privacy: { readReceipts: true, lastSeen: 'everyone' } });
  const [groupModal, setGroupModal] = useState(false);
  const [typingPeer, setTypingPeer] = useState<string | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [editMessage, setEditMessage] = useState<Message | null>(null);
  const [recording, setRecording] = useState<any>(null);
  const [statusViewer, setStatusViewer] = useState<StatusItem | null>(null);
  const [statusViewerImage, setStatusViewerImage] = useState<string | null>(null);
  const [localVideoStream, setLocalVideoStream] = useState<any>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<any>(null);
  const [activePartner, setActivePartner] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('chats');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [call, setCall] = useState<CallState | null>(null);
  const outboxKey = session ? `gramx-outbox-${session.username}` : '';
  const socketRef = useRef<Socket | null>(null);
  const callRef = useRef<CallState | null>(null);
  const peerConnectionRef = useRef<any>(null);
  const localStreamRef = useRef<any>(null);
  const pendingSignalsRef = useRef<any[]>([]);
  const pushTokenRef = useRef<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem('gramx-session').then(async (value) => {
      if (!value) return setBooting(false);
      const stored = JSON.parse(value) as Session;
      const result = await request<{ success: boolean; role?: 'user' | 'admin' }>('/session', { method: 'POST', body: JSON.stringify(stored) });
      if (result.success) setSession({ ...stored, role: result.role || stored.role || 'user' });
      else await AsyncStorage.removeItem('gramx-session');
      setBooting(false);
    }).catch(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!session || session.role === 'admin') return;
    let mounted = true;
    registerForPushNotificationsAsync().then(async (pushToken) => {
      if (!mounted || !pushToken) return;
      pushTokenRef.current = pushToken;
      await request('/push-token', {
        method: 'POST',
        headers: { 'x-username': session.username, 'x-token': session.token },
        body: JSON.stringify({ pushToken }),
      }).catch(() => undefined);
    }).catch(() => undefined);
    const responseListener = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { type?: string; from?: string };
      if (data?.type === 'incoming_call') setActiveTab('calls');
      if (data?.type === 'message' && data.from) { setActiveTab('chats'); setTimeout(() => openConversation(data.from!), 0); }
    });
    Notifications.getLastNotificationResponseAsync().then((response) => {
      const data = response?.notification.request.content.data as { type?: string; from?: string } | undefined;
      if (data?.type === 'incoming_call') setActiveTab('calls');
      if (data?.type === 'message' && data.from) { setActiveTab('chats'); setTimeout(() => openConversation(data.from!), 0); }
    }).catch(() => undefined);
    return () => { mounted = false; responseListener.remove(); };
  }, [session]);

  useEffect(() => {
    if (!session || session.role === 'admin') return;
    const socket = io(API_URL, { transports: ['websocket'], auth: session });
    socketRef.current = socket;
    socket.on('connect', () => {
      flushOutbox(socket).catch(() => undefined);
      socket.emit('get-active-call', {}, (reply: SocketReply<{ call?: { callId: string; role: 'caller' | 'callee'; peer: string; type: 'voice' | 'video'; state: CallState['state'] } | null }>) => {
        if (!reply.success || !reply.call) return;
        const restored = { callId: reply.call.callId, peer: reply.call.peer, role: reply.call.role, type: reply.call.type === 'video' ? 'video' as const : 'voice' as const, state: reply.call.state, incoming: reply.call.role === 'callee' && reply.call.state === 'ringing' };
        callRef.current = restored;
        setCall(restored);
      });
    });
    socket.on('message-deleted', ({ messageId }: { messageId: string }) => setMessages((current) => current.map((item) => item._id === messageId ? { ...item, deleted: true, text: '', image: null, audio: null } : item)));
    socket.on('message-edited', ({ messageId, text }: { messageId: string; text: string }) => setMessages((current) => current.map((item) => item._id === messageId ? { ...item, text, edited: true } : item)));
    socket.on('message-reaction', ({ messageId, reactions }: { messageId: string; reactions: Record<string, string> }) => setMessages((current) => current.map((item) => item._id === messageId ? { ...item, reactions } : item)));
    socket.on('message-pinned', ({ messageId, pinned, pinnedBy, pinnedAt }: { messageId: string; pinned: boolean; pinnedBy?: string | null; pinnedAt?: string | null }) => setMessages((current) => current.map((item) => item._id === messageId ? { ...item, pinned, pinnedBy: pinnedBy || null, pinnedAt: pinnedAt || null } : item)));
    socket.on('typing-start', ({ sender }: { sender: string }) => setTypingPeer(sender));
    socket.on('typing-stop', ({ sender }: { sender: string }) => setTypingPeer((current) => current === sender ? null : current));
    socket.on('new-private-message', (message: Message) => {
      if (message.sender === activePartner || message.receiver === activePartner) {
        setMessages((current) => [...current, message]);
      }
      loadConversations(socket);
    });
    socket.on('message-saved', ({ tempId, message }: { tempId?: string; message: Message }) => {
      setMessages((current) => { const index = current.findIndex((item) => tempId ? item.tempId === tempId : item.pending); if (index < 0) return current; return current.map((item, i) => i === index ? message : item); });
      loadConversations(socket);
    });
    socket.on('message-delivered', () => loadConversations(socket));
    socket.on('call-incoming', (incoming: { callId: string; from: string; type: 'voice' | 'video' }) => {
      const next = { callId: incoming.callId, peer: incoming.from, role: 'callee' as const, type: incoming.type, state: 'ringing' as const, incoming: true };
      callRef.current = next;
      setCall(next);
    });
    socket.on('call-accepted', async ({ callId }: { callId: string }) => {
      if (callRef.current?.callId === callId) {
        const next = { ...callRef.current, state: 'connecting' as const };
        callRef.current = next;
        setCall(next);
        await createPeerConnection(next, true);
      }
    });
    socket.on('call-signal', (signal: { callId: string; kind: string; data: any }) => handleCallSignal(signal));
    socket.on('call-state', ({ callId, state }: { callId: string; state: 'connected' }) => {
      if (callRef.current?.callId === callId) {
        const next = { ...callRef.current, state };
        callRef.current = next;
        setCall(next);
      }
    });
    socket.on('call-ended', ({ callId }: { callId: string }) => {
      if (callRef.current?.callId === callId) finishCall(false);
      loadCallHistory(socket);
    });
    loadConversations(socket);
    loadContacts();
    loadStatuses(socket);
    loadGroups(socket);
    loadCallHistory(socket);
    socket.on('group-message', (message: Message) => { setGroupMessages((current) => [...current, message]); loadGroups(socket); });
    socket.on('groups-changed', () => loadGroups(socket));
    socket.emit('get-user-settings', {}, (reply: SocketReply<{ settings: UserSettings }>) => { if (reply.success && reply.settings) setSettings(reply.settings); });
    socket.on('new-status', () => loadStatuses(socket));
    socket.on('status-activity', () => loadStatuses(socket));
    return () => { socket.disconnect(); socketRef.current = null; finishCall(false); };
  }, [session]);

  const activeTitle = useMemo(() => activePartner || '', [activePartner]);

  function loadConversations(socket = socketRef.current) {
    socket?.emit('get-conversations', (reply: SocketReply<{ conversations: Conversation[] }>) => {
      if (reply.success) setConversations(reply.conversations || []);
    });
  }

  function loadGroups(socket = socketRef.current) {
    socket?.emit('get-groups', {}, (reply: SocketReply<{ groups: Group[] }>) => { if (reply.success) setGroups(reply.groups || []); });
  }
  function loadCallHistory(socket = socketRef.current) {
    socket?.emit('get-calls', {}, (reply: SocketReply<{ calls: CallRecord[] }>) => { if (reply.success) setCallHistory(reply.calls || []); });
  }
  function openGroup(group: Group) {
    socketRef.current?.emit('join-group', { groupId: group._id }, (reply: SocketReply<{ messages: Message[] }>) => {
      if (reply.success) { setActiveGroup(group); setActivePartner(null); setGroupMessages(reply.messages || []); }
    });
  }
  function sendGroupMessage(payload: { text?: string; image?: string | null; audio?: string | null; audioDuration?: number }) {
    if (!activeGroup || (!payload.text?.trim() && !payload.image && !payload.audio)) return;
    socketRef.current?.emit('send-group-message', { groupId: activeGroup._id, ...payload, text: payload.text?.trim() || '' }, (reply: SocketReply<{ message: Message }>) => { if (!reply.success) setAuthError(reply.error || 'Could not send group message'); });
  }
  function sendGroupPhoto(image: string) { sendGroupMessage({ image }); }
  function sendGroupAudio(audio: string, audioDuration: number) { sendGroupMessage({ audio, audioDuration }); }
  function createGroup(name: string, members: string[]) {
    socketRef.current?.emit('create-group', { name, members }, (reply: SocketReply<{ group: Group }>) => {
      if (reply.success) { setGroupModal(false); loadGroups(); if (reply.group) openGroup(reply.group); }
    });
  }
  function updateSettings(patch: UserSettings) {
    const next = { ...settings, ...patch, privacy: { ...(settings.privacy || {}), ...(patch.privacy || {}) } };
    socketRef.current?.emit('update-settings', { settings: next }, (reply: SocketReply<{}>) => { if (reply.success) setSettings(next); });
  }
  function loadStatuses(socket = socketRef.current) {
    socket?.emit('get-statuses', {}, (reply: SocketReply<{ statuses: StatusItem[] }>) => {
      if (reply.success) setStatuses(reply.statuses || []);
    });
  }

  async function loadContacts() {
    if (!session) return;
    const result = await request<{ success: boolean; users?: Profile[] }>('/users', {
      headers: { 'x-username': session.username, 'x-token': session.token },
    }).catch(() => ({ success: false, users: [] as Profile[] }));
    if (result.success) setContacts(result.users || []);
  }

  function submitAuth() {
    setBusy(true); setAuthError('');
    const path = authMode === 'login' ? '/login' : '/register';
    const payload = authMode === 'login' ? { username: username.trim(), password } : { username: username.trim(), password, fullName: fullName.trim() };
    request<{ success: boolean; error?: string; token?: string; username?: string; role?: 'user' | 'admin' }>(path, { method: 'POST', body: JSON.stringify(payload) })
      .then(async (result) => {
        if (!result.success) return setAuthError(result.error || 'Could not continue');
        if (authMode === 'register') { setAuthMode('login'); setAuthError('Account created. Sign in to continue.'); return; }
        const next = { username: result.username || username.trim(), token: result.token || '', role: result.role || 'user' as const };
        await AsyncStorage.setItem('gramx-session', JSON.stringify(next));
        setSession(next);
      })
      .catch(() => setAuthError('Could not reach the B-MESSENGER server'))
      .finally(() => setBusy(false));
  }

  function openConversation(partner: string) {
    const socket = socketRef.current;
    if (!socket) return;
    socket.emit('join-conversation', { target: partner }, (reply: SocketReply<{ messages: Message[] }>) => {
      if (!reply.success) return setAuthError(reply.error || 'Could not open chat');
      setActivePartner(partner); setMessages(reply.messages || []);
    });
  }

  async function enqueueOutbox(payload: any) {
    if (!outboxKey) return;
    const current = JSON.parse((await AsyncStorage.getItem(outboxKey)) || '[]');
    current.push(payload);
    await AsyncStorage.setItem(outboxKey, JSON.stringify(current.slice(-100)));
  }

  async function flushOutbox(socket = socketRef.current) {
    if (!socket?.connected || !outboxKey) return;
    const queued = JSON.parse((await AsyncStorage.getItem(outboxKey)) || '[]');
    if (!queued.length) return;
    const remaining: any[] = [];
    for (const payload of queued) {
      const delivered = await new Promise<boolean>((resolve) => {
        socket.emit('send-private-message', payload, (reply: SocketReply<{ message: Message }>) => resolve(!!reply.success));
      });
      if (!delivered) remaining.push(payload);
    }
    await AsyncStorage.setItem(outboxKey, JSON.stringify(remaining));
  }

  function sendMessage() {
    const text = draft.trim();
    if (!text || !activePartner || !session) return;
    const tempId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = { receiver: activePartner, text, tempId };
    setDraft('');
    const pending: Message = { ...payload, sender: session.username, timestamp: new Date().toISOString(), pending: true };
    setMessages((current) => [...current, pending]);
    if (!socketRef.current?.connected) { enqueueOutbox(payload).catch(() => undefined); return; }
    socketRef.current.emit('send-private-message', payload, (reply: SocketReply<{ message: Message }>) => {
      if (!reply.success) { enqueueOutbox(payload).catch(() => undefined); setMessages((current) => current.map((item) => item.tempId === tempId ? { ...item, pending: true } : item)); }
    });
  }

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return null;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.72 });
    if (result.canceled || !result.assets[0]) return null;
    return toDataUrl(result.assets[0]);
  }
  function sendMedia(payload: { image?: string | null; audio?: string | null; audioDuration?: number }) {
    if (!activePartner || !session) return;
    const tempId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const queuedPayload = { receiver: activePartner, ...payload, tempId };
    const pending: Message = { sender: session.username, receiver: activePartner, ...payload, tempId, timestamp: new Date().toISOString(), pending: true };
    setMessages((current) => [...current, pending]);
    if (!socketRef.current?.connected) { enqueueOutbox(queuedPayload).catch(() => undefined); return; }
    socketRef.current.emit('send-private-message', queuedPayload, (reply: SocketReply<{ message: Message }>) => { if (!reply.success) enqueueOutbox(queuedPayload).catch(() => undefined); });
  }
  async function sendPhoto() { const image = await pickImage(); if (image) sendMedia({ image }); }
  async function startRecording() {
    if (Platform.OS === 'web') return;
    const permission = await Audio.requestPermissionsAsync(); if (!permission.granted) return;
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const next = new Audio.Recording();
    await next.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY); await next.startAsync(); setRecording(next);
  }
  async function stopRecording(target: 'private' | 'group' = 'private') {
    if (!recording) return;
    await recording.stopAndUnloadAsync(); const uri = recording.getURI(); const duration = recording.getStatusAsync ? Math.round(((await recording.getStatusAsync()).durationMillis || 0) / 1000) : 0;
    setRecording(null); if (!uri) return;
    const response = await fetch(uri); const blob = await response.blob(); const reader = new FileReader(); reader.onloadend = () => target === 'group' ? sendGroupAudio(String(reader.result), duration) : sendMedia({ audio: String(reader.result), audioDuration: duration }); reader.readAsDataURL(blob);
  }
  function messageAction(action: 'react' | 'star' | 'pin' | 'delete' | 'reply' | 'edit', message: Message) {
    if (!message._id || !socketRef.current) return;
    if (action === 'react') socketRef.current.emit('react-message', { messageId: message._id, emoji: message.reactions?.[session!.username] === '❤️' ? '' : '❤️' });
    if (action === 'star') { const next = !message.starred; socketRef.current.emit('star-message', { messageId: message._id, on: next }); setMessages((current) => current.map((item) => item._id === message._id ? { ...item, starred: next } : item)); }
    if (action === 'pin') { const next = !message.pinned; socketRef.current.emit('pin-message', { messageId: message._id, on: next }, (reply: SocketReply<{}>) => { if (reply.success) setMessages((current) => current.map((item) => item._id === message._id ? { ...item, pinned: next, pinnedBy: next ? session!.username : null } : item)); }); }
    if (action === 'delete') socketRef.current.emit('delete-message', { messageId: message._id });
    if (action === 'reply') { setDraft(`↳ ${message.text || 'Attachment'}\n`); }
    if (action === 'edit') setEditMessage(message);
    setSelectedMessage(null);
  }

  function startCall(peer: string, type: 'voice' | 'video') {
    if (!socketRef.current || callRef.current) return;
    socketRef.current.emit('call-invite', { to: peer, type }, (reply: SocketReply<{ callId?: string; status?: string }>) => {
      if (!reply.success || !reply.callId || reply.status !== 'ringing') return;
      const next = { callId: reply.callId, peer, role: 'caller' as const, type, state: 'ringing' as const };
      callRef.current = next; setCall(next);
    });
  }
  function startVoiceCall(peer: string) { startCall(peer, 'voice'); }
  function startVideoCall(peer: string) { startCall(peer, 'video'); }

  function acceptCall() {
    const current = callRef.current;
    if (!current || current.role !== 'callee' || !socketRef.current) return;
    socketRef.current.emit('call-accept', { callId: current.callId }, async (reply: SocketReply<{}>) => {
      if (!reply.success) return finishCall(false);
      const next = { ...current, state: 'connecting' as const };
      callRef.current = next;
      setCall(next);
      await createPeerConnection(next, false);
    });
  }

  async function createPeerConnection(current: CallState, createOffer: boolean) {
    if (!socketRef.current || !mediaDevices) return;
    const iceReply = await new Promise<SocketReply<{ iceServers: any[] }>>((resolve) => socketRef.current?.emit('get-ice-config', {}, resolve));
    const stream = await mediaDevices.getUserMedia({ audio: true, video: current.type === 'video' });
    localStreamRef.current = stream;
    if (current.type === 'video') setLocalVideoStream(stream);
    const pc: any = new RTCPeerConnection({ iceServers: iceReply.iceServers || [] });
    peerConnectionRef.current = pc;
    stream.getTracks().forEach((track: any) => pc.addTrack(track, stream));
    pc.ontrack = (event: any) => { const stream = event.streams?.[0]; if (stream) setRemoteVideoStream(stream); };
    pc.onicecandidate = (event: any) => {
      if (event.candidate) socketRef.current?.emit('call-signal', { callId: current.callId, kind: 'ice', data: event.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        socketRef.current?.emit('call-connected', { callId: current.callId });
        const next = { ...current, state: 'connected' as const };
        callRef.current = next;
        setCall(next);
      }
    };
    if (createOffer) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: current.type === 'video' });
      await pc.setLocalDescription(offer);
      socketRef.current.emit('call-signal', { callId: current.callId, kind: 'offer', data: offer });
    }
    const queued = pendingSignalsRef.current.splice(0);
    for (const signal of queued) await handleCallSignal(signal);
  }

  async function handleCallSignal(signal: { callId: string; kind: string; data: any }) {
    if (!callRef.current || callRef.current.callId !== signal.callId) return;
    const pc: any = peerConnectionRef.current;
    if (!pc) { pendingSignalsRef.current.push(signal); return; }
    if (signal.kind === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.emit('call-signal', { callId: signal.callId, kind: 'answer', data: answer });
    } else if (signal.kind === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
    } else if (signal.kind === 'ice') {
      await pc.addIceCandidate(new RTCIceCandidate(signal.data));
    }
  }

  function finishCall(notify = true) {
    const current = callRef.current;
    if (notify && current) socketRef.current?.emit(current.state === 'ringing' ? 'call-cancel' : 'call-end', { callId: current.callId });
    peerConnectionRef.current?.close?.();
    localStreamRef.current?.getTracks?.().forEach((track: any) => track.stop());
    peerConnectionRef.current = null;
    localStreamRef.current = null;
    setLocalVideoStream(null);
    setRemoteVideoStream(null);
    pendingSignalsRef.current = [];
    callRef.current = null;
    setCall(null);
  }

  function openStatus(item: StatusItem) {
    setStatusViewer(item);
    socketRef.current?.emit('view-status', { statusId: item._id });
    if (item.hasImage) socketRef.current?.emit('get-status-image', { statusId: item._id }, (reply: SocketReply<{ image: string | null }>) => { if (reply.success) setStatusViewerImage(reply.image || null); });
  }
  function toggleStatusLike(item: StatusItem) {
    socketRef.current?.emit('like-status', { statusId: item._id, liked: !item.likedByMe }, (reply: SocketReply<{}>) => { if (reply.success) loadStatuses(); });
  }
  function deleteStatus(item: StatusItem) {
    socketRef.current?.emit('delete-status', { statusId: item._id }, (reply: SocketReply<{}>) => { if (reply.success) { setStatusViewer(null); loadStatuses(); } });
  }
  function submitEdit(text: string) {
    if (!editMessage?._id || !text.trim()) return;
    socketRef.current?.emit('edit-message', { messageId: editMessage._id, text: text.trim() }, (reply: SocketReply<{}>) => { if (reply.success) { setMessages((current) => current.map((item) => item._id === editMessage._id ? { ...item, text: text.trim(), edited: true } : item)); setEditMessage(null); } });
  }

  async function signOut() {
    if (session && pushTokenRef.current) await request('/push-token', {
      method: 'DELETE',
      headers: { 'x-username': session.username, 'x-token': session.token },
      body: JSON.stringify({ pushToken: pushTokenRef.current }),
    }).catch(() => undefined);
    if (session) await request('/logout', { method: 'POST', body: JSON.stringify(session) }).catch(() => undefined);
    if (session?.role === 'admin') await request('/admin/logout', { method: 'POST', headers: { 'x-admin-token': session.token } }).catch(() => undefined);
    await AsyncStorage.removeItem('gramx-session');
    pushTokenRef.current = null;
    setSession(null); setActivePartner(null); setMessages([]);
  }

  if (booting) return <View style={styles.center}><ActivityIndicator color={BRAND} /></View>;
  if (!session) return <AuthScreen {...{ authMode, setAuthMode, username, setUsername, password, setPassword, fullName, setFullName, authError, busy, submitAuth }} />;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      {activeGroup ? (
        <GroupChatScreen group={activeGroup} messages={groupMessages} session={session} onBack={() => setActiveGroup(null)} sendMessage={sendGroupMessage} sendPhoto={async () => { const image = await pickImage(); if (image) sendGroupPhoto(image); }} recording={!!recording} startRecording={startRecording} stopRecording={() => stopRecording('group')} />
      ) : activePartner ? (
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}><Pressable onPress={() => setActivePartner(null)}><Text style={styles.back}>‹</Text></Pressable><Avatar name={activeTitle} small /><View style={styles.headerCopy}><Text style={styles.title}>{activeTitle}</Text><Text style={styles.subtitle}>{typingPeer === activeTitle ? 'typing…' : 'Private chat'}</Text></View><Pressable style={styles.phoneButton} onPress={() => startVoiceCall(activeTitle)}><Text style={styles.phoneButtonText}>☎</Text></Pressable><Pressable style={styles.videoButton} onPress={() => startVideoCall(activeTitle)}><Text style={styles.phoneButtonText}>▣</Text></Pressable></View>
          <FlatList data={messages} keyExtractor={(item, index) => item._id || `${item.timestamp}-${index}`} contentContainerStyle={styles.messageList} renderItem={({ item }) => <MessageBubble item={item} mine={item.sender === session.username} onPress={() => setSelectedMessage(item)} />} />
          <View style={styles.composer}><Pressable style={styles.attach} onPress={sendPhoto}><Text style={styles.attachText}>＋</Text></Pressable><Pressable style={styles.attach} onPress={() => recording ? stopRecording() : startRecording()}><Text style={[styles.attachText, recording && { color: '#FF708A' }]}>{recording ? '■' : '◉'}</Text></Pressable><TextInput value={draft} onChangeText={(text) => { setDraft(text); socketRef.current?.emit(text ? 'typing-start' : 'typing-stop', { receiver: activeTitle }); }} onBlur={() => socketRef.current?.emit('typing-stop', { receiver: activeTitle })} placeholder={recording ? 'Recording voice note…' : 'Write a message'} placeholderTextColor={MUTED} style={styles.input} multiline /><Pressable style={styles.send} onPress={sendMessage}><Text style={styles.sendText}>Send</Text></Pressable></View>
        </KeyboardAvoidingView>
      ) : (
        <View style={styles.flex}>
          {activeTab === 'chats' && <ChatsScreen session={session} conversations={conversations} groups={groups} openConversation={openConversation} openGroup={openGroup} />}
          {activeTab === 'status' && <StatusScreen statuses={statuses} addStatus={(payload) => socketRef.current?.emit('add-status', payload, () => loadStatuses())} onOpen={openStatus} onLike={toggleStatusLike} onDelete={deleteStatus} />}
          {activeTab === 'calls' && <CallsScreen username={session.username} calls={callHistory} startVoiceCall={startVoiceCall} startVideoCall={startVideoCall} />}
          {activeTab === 'contacts' && <ContactsScreen contacts={contacts} openConversation={openConversation} startVoiceCall={startVoiceCall} onCreateGroup={() => setGroupModal(true)} />}
          {activeTab === 'settings' && <SettingsScreen username={session.username} settings={settings} updateSettings={updateSettings} signOut={signOut} />}
          {activeTab === 'admin' && session.role === 'admin' && <AdminDashboard session={session} />}
          <BottomNav activeTab={activeTab} setActiveTab={setActiveTab} isAdmin={session.role === 'admin'} />
        </View>
      )}
      {call && <CallOverlay call={call} localStream={localVideoStream} remoteStream={remoteVideoStream} acceptCall={acceptCall} finishCall={() => finishCall(true)} />}
      {selectedMessage && <MessageActionsModal message={selectedMessage} onClose={() => setSelectedMessage(null)} onAction={(action) => messageAction(action, selectedMessage)} />}
      {editMessage && <EditMessageModal message={editMessage} onClose={() => setEditMessage(null)} onSave={submitEdit} />}
      {statusViewer && <StatusViewerModal status={statusViewer} image={statusViewerImage} onClose={() => { setStatusViewer(null); setStatusViewerImage(null); }} onLike={() => toggleStatusLike(statusViewer)} onDelete={() => deleteStatus(statusViewer)} currentUser={session.username} />}
      {groupModal && <CreateGroupModal contacts={contacts} onClose={() => setGroupModal(false)} onCreate={createGroup} />}
    </SafeAreaView>
  );
}

function Header({ title, subtitle, avatar, onBack, action }: { title: string; subtitle?: string; avatar?: string; onBack?: () => void; action?: any }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: LINE }}>
    {onBack && <Pressable onPress={onBack} style={{ width: 32 }}><Text style={{ color: '#FFF', fontSize: 34, lineHeight: 32 }}>‹</Text></Pressable>}
    {avatar ? <Avatar name={avatar} small /> : <View style={{ width: 38, height: 38, borderRadius: 13, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#041326', fontWeight: '900', fontSize: 23 }}>B</Text></View>}
    <View style={{ flex: 1, marginLeft: 11 }}><Text style={{ color: '#FFF', fontSize: 18, fontWeight: '800', letterSpacing: 0.3 }}>{title}</Text>{subtitle && <Text style={{ color: MUTED, marginTop: 3, fontSize: 12 }}>{subtitle}</Text>}</View>
    {action}
  </View>;
}

function ChatsScreen({ session, conversations, groups, openConversation, openGroup }: { session: Session; conversations: Conversation[]; groups: Group[]; openConversation: (partner: string) => void; openGroup: (group: Group) => void }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'chats' | 'groups'>('chats');
  const visible = conversations.filter((item) => (item.profile?.displayName || item.partner).toLowerCase().includes(query.toLowerCase()));
  return <View style={styles.flex}><Header title="B-MESSENGER" subtitle="Chat  ·  Connect  ·  Always" action={<View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: GREEN }} />} /><View style={{ paddingHorizontal: 18, paddingTop: 18, paddingBottom: 10 }}><Text style={{ color: '#FFF', fontSize: 27, fontWeight: '800' }}>Messages</Text><Text style={{ color: MUTED, marginTop: 4 }}>Stay close to the people who matter.</Text></View><View style={{ marginHorizontal: 18, marginBottom: 14, backgroundColor: PANEL, borderRadius: 13, borderWidth: 1, borderColor: LINE, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13 }}><Text style={{ color: BRAND, fontSize: 18 }}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder={tab === 'chats' ? 'Search chats' : 'Search groups'} placeholderTextColor={MUTED} style={{ flex: 1, color: '#FFF', paddingVertical: 12, paddingHorizontal: 9 }} /></View><View style={{ flexDirection: 'row', paddingHorizontal: 18, paddingBottom: 10, gap: 9 }}><Pressable onPress={() => setTab('chats')} style={{ backgroundColor: tab === 'chats' ? BRAND : PANEL, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14 }}><Text style={{ color: tab === 'chats' ? '#041326' : MUTED, fontWeight: '800', fontSize: 12 }}>CHATS</Text></Pressable><Pressable onPress={() => setTab('groups')} style={{ backgroundColor: tab === 'groups' ? BRAND : PANEL, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14 }}><Text style={{ color: tab === 'groups' ? '#041326' : MUTED, fontWeight: '800', fontSize: 12 }}>GROUPS</Text></Pressable></View>{tab === 'chats' ? <FlatList data={visible} keyExtractor={(item) => item.partner} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 18 }} ListEmptyComponent={<Text style={styles.empty}>No conversations yet. Open Contacts to start a chat.</Text>} renderItem={({ item }) => <Pressable style={{ flexDirection: 'row', alignItems: 'center', padding: 13, borderRadius: 17, backgroundColor: PANEL, marginBottom: 9, borderWidth: 1, borderColor: LINE }} onPress={() => openConversation(item.partner)}><Avatar name={item.profile?.displayName || item.partner} /><View style={{ flex: 1, marginLeft: 12 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={styles.rowTitle}>{item.profile?.displayName || item.partner}</Text><Text style={{ color: MUTED, fontSize: 11 }}>{item.lastMessage?.timestamp ? formatTime(item.lastMessage.timestamp) : ''}</Text></View><Text style={styles.rowSub} numberOfLines={1}>{item.lastMessage?.text || 'Start a conversation'}</Text></View>{(item.unread || 0) > 0 && <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center', marginLeft: 7 }}><Text style={{ color: '#041326', fontSize: 11, fontWeight: '800' }}>{item.unread}</Text></View>}</Pressable>} /> : <FlatList data={groups.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))} keyExtractor={(item) => item._id} contentContainerStyle={{ paddingHorizontal: 16 }} ListEmptyComponent={<Text style={styles.empty}>No groups yet. Create one from the web app or ask an admin.</Text>} renderItem={({ item }) => <Pressable style={{ flexDirection: 'row', alignItems: 'center', padding: 13, borderRadius: 17, backgroundColor: PANEL, marginBottom: 9, borderWidth: 1, borderColor: LINE }} onPress={() => openGroup(item)}><Avatar name={item.name} accent={BRAND} /><View style={{ flex: 1, marginLeft: 12 }}><Text style={styles.rowTitle}>{item.name}</Text><Text style={styles.rowSub}>{item.members?.length || 0} members · {item.lastMessage?.text || 'No messages yet'}</Text></View>{(item.unreadCount || 0) > 0 && <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#041326', fontSize: 11, fontWeight: '800' }}>{item.unreadCount}</Text></View>}</Pressable>} />}</View>;
}

function GroupChatScreen({ group, messages, session, onBack, sendMessage, sendPhoto, recording, startRecording, stopRecording }: { group: Group; messages: Message[]; session: Session; onBack: () => void; sendMessage: (payload: { text?: string; image?: string | null; audio?: string | null; audioDuration?: number }) => void; sendPhoto: () => void; recording: boolean; startRecording: () => void; stopRecording: () => void }) {
  const [draft, setDraft] = useState('');
  function send() { if (!draft.trim()) return; sendMessage({ text: draft }); setDraft(''); }
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><View style={styles.header}><Pressable onPress={onBack}><Text style={styles.back}>‹</Text></Pressable><Avatar name={group.name} small /><View style={styles.headerCopy}><Text style={styles.title}>{group.name}</Text><Text style={styles.subtitle}>{group.members?.length || 0} members</Text></View></View><FlatList data={messages} keyExtractor={(item, index) => item._id || `${item.timestamp}-${index}`} contentContainerStyle={styles.messageList} renderItem={({ item }) => <MessageBubble item={item} mine={item.sender === session.username} onPress={() => undefined} />} /><View style={styles.composer}><Pressable style={styles.attach} onPress={sendPhoto}><Text style={styles.attachText}>＋</Text></Pressable><Pressable style={styles.attach} onPress={recording ? stopRecording : startRecording}><Text style={[styles.attachText, recording && { color: '#FF708A' }]}>{recording ? '■' : '◉'}</Text></Pressable><TextInput value={draft} onChangeText={setDraft} onSubmitEditing={send} placeholder={recording ? 'Recording voice note…' : 'Message group'} placeholderTextColor={MUTED} style={styles.input} /><Pressable style={styles.send} onPress={send}><Text style={styles.sendText}>Send</Text></Pressable></View></KeyboardAvoidingView>;
}

function MessageBubble({ item, mine, onPress }: { item: Message; mine: boolean; onPress: () => void }) {
  if (item.deleted) return <View style={[styles.bubble, mine ? styles.myBubble : styles.theirBubble]}><Text style={styles.deletedText}>This message was deleted</Text></View>;
  return <Pressable onLongPress={onPress} onPress={item.image || item.audio ? undefined : onPress} style={[styles.bubble, mine ? styles.myBubble : styles.theirBubble]}>{item.pinned && <Text style={{ color: BRAND, fontSize: 11, fontWeight: '800', marginBottom: 5 }}>⌖ Pinned message</Text>}{item.image && <Image source={{ uri: item.image }} style={styles.messageImage} resizeMode="cover" />}{item.audio && <VoiceNote uri={item.audio} duration={item.audioDuration || 0} />}{item.text && <Text style={styles.messageText}>{item.text}{item.edited ? '  (edited)' : ''}</Text>}<View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5 }}><Text style={styles.messageTime}>{item.pending ? 'Sending…' : formatTime(item.timestamp)}</Text>{item.pinned && <Text style={{ color: BRAND, fontSize: 11 }}>⌖</Text>}{item.starred && <Text style={{ color: '#FFD35A', fontSize: 11 }}>★</Text>}{item.reactions && Object.values(item.reactions).length > 0 && <Text style={{ color: '#FFF', fontSize: 12 }}>{Object.values(item.reactions).join(' ')}</Text>}</View></Pressable>;
}
function VoiceNote({ uri, duration }: { uri: string; duration: number }) {
  const [playing, setPlaying] = useState(false);
  const sound = useRef<Audio.Sound | null>(null);
  async function toggle() { if (playing) { await sound.current?.pauseAsync(); setPlaying(false); return; } const result = await Audio.Sound.createAsync({ uri }, { shouldPlay: true }); sound.current = result.sound; setPlaying(true); result.sound.setOnPlaybackStatusUpdate((status: any) => { if (status.didJustFinish) setPlaying(false); }); }
  useEffect(() => () => { sound.current?.unloadAsync(); }, []);
  return <Pressable onPress={toggle} style={styles.voiceNote}><Text style={{ color: BRAND, fontSize: 18 }}>{playing ? 'Ⅱ' : '▶'}</Text><View style={styles.wave}><View style={styles.waveLine} /><View style={[styles.waveLine, { height: 20 }]} /><View style={[styles.waveLine, { height: 12 }]} /><View style={[styles.waveLine, { height: 24 }]} /><View style={[styles.waveLine, { height: 16 }]} /></View><Text style={{ color: MUTED, fontSize: 11 }}>{duration || 0}s</Text></Pressable>;
}
function MessageActionsModal({ message, onClose, onAction }: { message: Message; onClose: () => void; onAction: (action: 'react' | 'star' | 'pin' | 'delete' | 'reply' | 'edit') => void }) {
  const actions: Array<['❤️' | '★' | '⌖' | '↩' | '✎' | '⌫', 'react' | 'star' | 'pin' | 'reply' | 'edit' | 'delete']> = [['❤️', 'react'], ['★', 'star'], ['⌖', 'pin'], ['↩', 'reply'], ['✎', 'edit'], ['⌫', 'delete']];
  return <Modal transparent animationType="fade" visible onRequestClose={onClose}><View style={styles.modalBackdrop}><View style={styles.actionCard}><Text style={styles.callTitle}>Message actions</Text>{actions.map(([icon, action]) => <Pressable key={action} onPress={() => onAction(action)} style={styles.actionRow}><Text style={{ color: action === 'delete' ? '#FF8A9B' : BRAND, fontSize: 20, width: 32 }}>{icon}</Text><Text style={{ color: '#FFF', fontSize: 16 }}>{action === 'react' ? 'React with heart' : action === 'star' ? 'Star message' : action === 'pin' ? (message.pinned ? 'Unpin message' : 'Pin message') : action === 'reply' ? 'Reply' : action === 'edit' ? 'Edit message' : 'Delete message'}</Text></Pressable>)}<Pressable onPress={onClose} style={styles.cancelAction}><Text style={{ color: MUTED }}>Cancel</Text></Pressable></View></View></Modal>;
}
function EditMessageModal({ message, onClose, onSave }: { message: Message; onClose: () => void; onSave: (text: string) => void }) { const [text, setText] = useState(message.text || ''); return <Modal transparent animationType="fade" visible onRequestClose={onClose}><View style={styles.modalBackdrop}><View style={styles.actionCard}><Text style={styles.callTitle}>Edit message</Text><TextInput value={text} onChangeText={setText} style={styles.authInput} autoFocus /><Pressable style={styles.primary} onPress={() => onSave(text)}><Text style={styles.primaryText}>Save changes</Text></Pressable></View></View></Modal>; }
function StatusViewerModal({ status, image, onClose, onLike, onDelete, currentUser }: { status: StatusItem; image: string | null; onClose: () => void; onLike: () => void; onDelete: () => void; currentUser: string }) { return <Modal transparent animationType="fade" visible onRequestClose={onClose}><View style={styles.statusViewer}><Pressable onPress={onClose} style={styles.viewerClose}><Text style={styles.back}>×</Text></Pressable>{image ? <Image source={{ uri: image }} style={styles.statusImage} resizeMode="contain" /> : <Text style={styles.statusViewerText}>{status.text || 'Photo status'}</Text>}<Text style={styles.statusViewerUser}>{status.user}</Text><View style={styles.viewerActions}><Pressable onPress={onLike} style={styles.viewerAction}><Text style={{ color: status.likedByMe ? '#FF789B' : '#FFF', fontSize: 20 }}>♥</Text><Text style={{ color: '#FFF' }}>{status.likeCount || 0}</Text></Pressable>{status.user === currentUser && <Pressable onPress={onDelete} style={styles.viewerAction}><Text style={{ color: '#FF8A9B', fontSize: 16 }}>Delete</Text></Pressable>}</View></View></Modal>; }

function StatusScreen({ statuses, addStatus, onOpen, onLike, onDelete }: { statuses: StatusItem[]; addStatus: (payload: { text?: string; image?: string | null }) => void; onOpen: (item: StatusItem) => void; onLike: (item: StatusItem) => void; onDelete: (item: StatusItem) => void }) {
  const [draft, setDraft] = useState('');
  async function publishPhoto() { const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.72 }); if (!result.canceled && result.assets[0]) addStatus({ image: toDataUrl(result.assets[0]) }); }
  function publish() { const text = draft.trim(); if (!text) return; addStatus({ text }); setDraft(''); }
  return <View style={styles.flex}><Header title="Status" subtitle="Share a moment with your contacts" action={<Pressable style={styles.newButton} onPress={publish}><Text style={styles.newButtonText}>↑</Text></Pressable>} /><View style={{ margin: 18, padding: 14, borderRadius: 18, backgroundColor: PANEL, borderWidth: 1, borderColor: LINE }}><Text style={{ color: '#FFF', fontSize: 15, fontWeight: '800', marginBottom: 9 }}>My Status</Text><View style={{ flexDirection: 'row', alignItems: 'center' }}><Pressable onPress={publishPhoto} style={{ width: 38, height: 38, borderRadius: 13, borderWidth: 1, borderColor: BRAND, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: BRAND, fontSize: 19 }}>▧</Text></Pressable><TextInput value={draft} onChangeText={setDraft} onSubmitEditing={publish} placeholder="Share a thought..." placeholderTextColor={MUTED} style={{ flex: 1, color: '#FFF', marginLeft: 10, paddingVertical: 9 }} returnKeyType="send" /></View></View><FlatList data={statuses} keyExtractor={(item) => item._id} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 20 }} ListHeaderComponent={<Text style={{ color: MUTED, fontSize: 12, fontWeight: '800', letterSpacing: 1, marginBottom: 10 }}>RECENT UPDATES</Text>} ListEmptyComponent={<View style={{ alignItems: 'center', paddingTop: 55 }}><Text style={{ color: BRAND, fontSize: 40 }}>◌</Text><Text style={{ color: '#FFF', fontSize: 18, fontWeight: '800', marginTop: 12 }}>No recent updates</Text><Text style={styles.empty}>Your contacts’ status updates will appear here.</Text></View>} renderItem={({ item }) => <Pressable onPress={() => onOpen(item)} onLongPress={() => item.hasImage && onDelete(item)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: LINE }}><Avatar name={item.user} ring accent={item.bg || BRAND} /><View style={{ marginLeft: 13, flex: 1 }}><Text style={styles.rowTitle}>{item.user}</Text><Text style={styles.rowSub} numberOfLines={1}>{item.text || (item.hasImage ? 'Photo status' : 'Status update')}</Text><Text style={{ color: MUTED, fontSize: 10, marginTop: 4 }}>{item.viewCount || 0} views · {item.likeCount || 0} likes</Text></View><Pressable onPress={() => onLike(item)} style={{ padding: 8 }}><Text style={{ color: item.likedByMe ? '#FF789B' : MUTED, fontSize: 19 }}>♥</Text></Pressable><Text style={{ color: MUTED, fontSize: 11 }}>{item.viewedByMe ? 'Viewed' : 'New'}</Text></Pressable>} /></View>;
}

function CallsScreen({ username, calls, startVoiceCall, startVideoCall }: { username: string; calls: CallRecord[]; startVoiceCall: (peer: string) => void; startVideoCall: (peer: string) => void }) {
  return <View style={styles.flex}><Header title="Calls" subtitle="Voice and video, closer than ever" /><FlatList data={[...calls].reverse()} keyExtractor={(item, index) => `${item.startedAt}-${item.caller}-${item.callee}-${index}`} contentContainerStyle={{ padding: 18 }} ListHeaderComponent={<Text style={{ color: '#FFF', fontSize: 22, fontWeight: '800', marginBottom: 14 }}>Recent calls</Text>} ListEmptyComponent={<Text style={styles.empty}>Your recent calls will appear here.</Text>} renderItem={({ item }) => { const peer = item.caller === username ? item.callee : item.caller; const direction = item.caller === username ? 'Outgoing' : 'Incoming'; const outcome = item.status === 'completed' ? `${direction} · ${item.durationSec}s` : `${direction} · ${item.status}`; return <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: LINE }}><Avatar name={peer} /><View style={{ flex: 1, marginLeft: 12 }}><Text style={styles.rowTitle}>{peer}</Text><Text style={styles.rowSub}>{item.type === 'video' ? 'Video' : 'Voice'} call · {outcome} · {formatTime(item.startedAt)}</Text></View><Pressable onPress={() => startVoiceCall(peer)} style={styles.callListButton}><Text style={{ color: BRAND, fontSize: 18 }}>☎</Text></Pressable><Pressable onPress={() => startVideoCall(peer)} style={styles.callListButton}><Text style={{ color: BRAND, fontSize: 18 }}>▣</Text></Pressable></View>; }} /></View>;
}

function ContactsScreen({ contacts, openConversation, startVoiceCall, onCreateGroup }: { contacts: Profile[]; openConversation: (partner: string) => void; startVoiceCall: (peer: string) => void; onCreateGroup: () => void }) {
  const [query, setQuery] = useState('');
  const visible = contacts.filter((item) => (item.displayName || item.username).toLowerCase().includes(query.toLowerCase()));
  return <View style={styles.flex}><Header title="Contacts" subtitle={`${contacts.length} people on B-MESSENGER`} action={<Pressable style={styles.newButton} onPress={onCreateGroup}><Text style={styles.newButtonText}>＋</Text></Pressable>} /><View style={{ margin: 18, marginBottom: 8, backgroundColor: PANEL, borderRadius: 13, borderWidth: 1, borderColor: LINE, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13 }}><Text style={{ color: BRAND, fontSize: 18 }}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder="Search contacts" placeholderTextColor={MUTED} style={{ flex: 1, color: '#FFF', paddingVertical: 12, paddingHorizontal: 9 }} /></View><FlatList data={visible} keyExtractor={(item) => item.username} contentContainerStyle={{ paddingHorizontal: 18 }} ListEmptyComponent={<Text style={styles.empty}>No contacts match your search.</Text>} renderItem={({ item }) => <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: LINE }}><Avatar name={item.displayName || item.username} /><View style={{ flex: 1, marginLeft: 12 }}><Text style={styles.rowTitle}>{item.displayName || item.username}</Text><Text style={styles.rowSub}>@{item.username} · Available to chat</Text></View><Pressable onPress={() => openConversation(item.username)} style={{ padding: 9 }}><Text style={{ color: BRAND, fontSize: 18 }}>▣</Text></Pressable><Pressable onPress={() => startVoiceCall(item.username)} style={{ padding: 9 }}><Text style={{ color: BRAND, fontSize: 18 }}>☎</Text></Pressable></View>} /></View>;
}

function CreateGroupModal({ contacts, onClose, onCreate }: { contacts: Profile[]; onClose: () => void; onCreate: (name: string, members: string[]) => void }) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  function toggle(username: string) { setSelected((current) => current.includes(username) ? current.filter((item) => item !== username) : [...current, username]); }
  return <Modal transparent animationType="slide" visible onRequestClose={onClose}><View style={styles.modalBackdrop}><View style={styles.modalCard}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={styles.callTitle}>New group</Text><Pressable onPress={onClose}><Text style={styles.back}>×</Text></Pressable></View><TextInput value={name} onChangeText={setName} placeholder="Group name" placeholderTextColor={MUTED} style={styles.authInput} /><Text style={{ color: MUTED, fontSize: 12, fontWeight: '800', letterSpacing: 1, marginTop: 18, marginBottom: 8 }}>ADD MEMBERS</Text><FlatList data={contacts} keyExtractor={(item) => item.username} style={{ maxHeight: 260 }} renderItem={({ item }) => <Pressable onPress={() => toggle(item.username)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}><Avatar name={item.displayName || item.username} small /><Text style={{ color: '#FFF', flex: 1, marginLeft: 10 }}>{item.displayName || item.username}</Text><Text style={{ color: selected.includes(item.username) ? BRAND : MUTED, fontSize: 24 }}>{selected.includes(item.username) ? '✓' : '＋'}</Text></Pressable>} /><Pressable style={styles.primary} onPress={() => name.trim() && selected.length > 0 && onCreate(name.trim(), selected)}><Text style={styles.primaryText}>Create group</Text></Pressable></View></View></Modal>;
}

function SettingsScreen({ username, settings, updateSettings, signOut }: { username: string; settings: UserSettings; updateSettings: (patch: UserSettings) => void; signOut: () => void }) {
  const [displayName, setDisplayName] = useState(settings.displayName || username);
  const [about, setAbout] = useState(settings.about || '');
  const rows = [['◉', 'Account', 'Profile, name and about'], ['◌', 'Privacy', 'Last seen and read receipts'], ['◈', 'Notifications', 'Messages, calls and status'], ['✦', 'Appearance', 'Dark theme · B-Messenger blue'], ['⌁', 'Chat settings', 'Wallpaper and message preferences'], ['?', 'Help & support', 'Get help with B-Messenger']];
  return <View style={styles.flex}><Header title="Settings" subtitle="Make B-MESSENGER yours" /><ScrollView contentContainerStyle={{ padding: 18 }}><View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 18, backgroundColor: PANEL, borderWidth: 1, borderColor: LINE, marginBottom: 18 }}><Avatar name={displayName} size={58} ring /><View style={{ marginLeft: 13, flex: 1 }}><Text style={{ color: '#FFF', fontSize: 19, fontWeight: '800' }}>{displayName}</Text><Text style={styles.rowSub}>Your B-MESSENGER account</Text></View></View><Text style={{ color: MUTED, fontSize: 12, fontWeight: '800', letterSpacing: 1, marginBottom: 8 }}>PROFILE</Text><TextInput value={displayName} onChangeText={setDisplayName} placeholder="Display name" placeholderTextColor={MUTED} style={styles.authInput} /><TextInput value={about} onChangeText={setAbout} placeholder="About you" placeholderTextColor={MUTED} style={styles.authInput} /><Pressable style={[styles.primary, { marginBottom: 18 }]} onPress={() => updateSettings({ displayName, about })}><Text style={styles.primaryText}>Save profile</Text></Pressable>{rows.map(([icon, title, sub]) => <View key={title} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: LINE }}><Text style={{ color: BRAND, fontSize: 18, width: 33 }}>{icon}</Text><View style={{ flex: 1 }}><Text style={{ color: '#FFF', fontSize: 15, fontWeight: '700' }}>{title}</Text><Text style={{ color: MUTED, fontSize: 12, marginTop: 3 }}>{sub}</Text></View>{title === 'Notifications' ? <Switch value={settings.notifications !== false} onValueChange={(value) => updateSettings({ notifications: value })} trackColor={{ false: LINE, true: BRAND_DARK }} thumbColor={settings.notifications !== false ? BRAND : MUTED} /> : <Text style={{ color: MUTED, fontSize: 23 }}>›</Text>}</View>)}<Pressable style={{ alignItems: 'center', paddingVertical: 22 }} onPress={signOut}><Text style={{ color: '#FF9B9B', fontWeight: '800' }}>Sign out</Text></Pressable><Text style={{ color: MUTED, fontSize: 12, textAlign: 'center', marginTop: 8 }}>B-MESSENGER mobile · v1.0</Text></ScrollView></View>;
}

function AdminDashboard({ session }: { session: Session }) {
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [error, setError] = useState('');
  const headers = { 'x-admin-token': session.token };
  async function load() {
    const [statsReply, usersReply, reportsReply] = await Promise.all([request<any>('/admin/stats', { headers }), request<any>('/admin/users', { headers }), request<any>('/admin/reports', { headers })]);
    if (!statsReply.success || !usersReply.success || !reportsReply.success) { setError('Could not load admin data'); return; }
    setStats(statsReply.stats); setUsers(usersReply.users || []); setReports(reportsReply.reports || []); setError('');
  }
  useEffect(() => { load().catch(() => setError('Could not reach the admin service')); }, []);
  async function act(username: string, action: string) {
    const result = await request<any>(`/admin/users/${encodeURIComponent(username)}/action`, { method: 'POST', headers, body: JSON.stringify({ action }) });
    if (result.success) load(); else setError(result.error || 'Action failed');
  }
  return <View style={styles.flex}><Header title="Admin" subtitle="Live platform operations" action={<Pressable onPress={() => load()}><Text style={{ color: BRAND, fontWeight: '800' }}>Refresh</Text></Pressable>} /><ScrollView contentContainerStyle={{ padding: 18 }}><Text style={{ color: MUTED, fontSize: 12, fontWeight: '800', letterSpacing: 1, marginBottom: 10 }}>OVERVIEW</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{[['Users', stats?.users], ['Online', stats?.online], ['Messages', stats?.messages], ['Groups', stats?.groups], ['Statuses', stats?.activeStatuses], ['Reports', reports.length]].map(([label, value]) => <View key={String(label)} style={{ width: '47%', padding: 16, borderRadius: 16, backgroundColor: PANEL, borderWidth: 1, borderColor: LINE }}><Text style={{ color: MUTED, fontSize: 12 }}>{label}</Text><Text style={{ color: '#FFF', fontSize: 26, fontWeight: '800', marginTop: 6 }}>{value ?? '—'}</Text></View>)}</View>{error ? <Text style={styles.error}>{error}</Text> : null}<Text style={{ color: MUTED, fontSize: 12, fontWeight: '800', letterSpacing: 1, marginTop: 24, marginBottom: 10 }}>USERS</Text>{users.slice(0, 50).map((user) => <View key={user.username} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: LINE }}><Avatar name={user.fullName || user.username} small /><View style={{ flex: 1, marginLeft: 10 }}><Text style={styles.rowTitle}>{user.fullName || user.username}</Text><Text style={styles.rowSub}>@{user.username} · {user.online ? 'Online' : user.status}</Text></View>{user.status === 'active' ? <Pressable onPress={() => act(user.username, 'suspend')}><Text style={{ color: '#FFB86B', fontWeight: '800' }}>Suspend</Text></Pressable> : <Pressable onPress={() => act(user.username, 'unsuspend')}><Text style={{ color: GREEN, fontWeight: '800' }}>Restore</Text></Pressable>}</View>)}</ScrollView></View>;
}

function BottomNav({ activeTab, setActiveTab, isAdmin = false }: { activeTab: AppTab; setActiveTab: (tab: AppTab) => void; isAdmin?: boolean }) {
  const items: { key: AppTab; label: string; icon: string }[] = [{ key: 'chats', label: 'Chats', icon: '◒' }, { key: 'status', label: 'Status', icon: '◌' }, { key: 'calls', label: 'Calls', icon: '⌁' }, { key: 'contacts', label: 'Contacts', icon: '♧' }, { key: 'settings', label: 'Settings', icon: '⚙' }, ...(isAdmin ? [{ key: 'admin' as const, label: 'Admin', icon: '▦' }] : [])];
  return <View style={styles.bottomNav}>{items.map((item) => <Pressable key={item.key} style={styles.navItem} onPress={() => setActiveTab(item.key)}><Text style={[styles.navIcon, activeTab === item.key && styles.navIconActive]}>{item.icon}</Text><Text style={[styles.navLabel, activeTab === item.key && styles.navLabelActive]}>{item.label}</Text></Pressable>)}</View>;
}

function CallOverlay({ call, localStream, remoteStream, acceptCall, finishCall }: { call: CallState; localStream: any; remoteStream: any; acceptCall: () => void; finishCall: () => void }) {
  const incoming = call.incoming && call.state === 'ringing';
  return <View style={styles.callOverlay}>{call.type === 'video' && <View style={styles.videoStage}>{remoteStream && <RTCView streamURL={remoteStream.toURL?.()} style={styles.remoteVideo} objectFit="cover" />} {localStream && <RTCView streamURL={localStream.toURL?.()} style={styles.localVideo} objectFit="cover" />}</View>}<View style={styles.callCard}><Avatar name={call.peer} /><Text style={styles.callTitle}>{incoming ? `Incoming ${call.type} call` : call.state === 'connected' ? `${call.type === 'video' ? 'Video' : 'Voice'} call` : 'Calling…'}</Text><Text style={styles.callPeer}>{call.peer}</Text><Text style={styles.callStatus}>{call.state === 'connected' ? 'Connected' : incoming ? `B-MESSENGER ${call.type} call` : 'Waiting for answer'}</Text><View style={styles.callActions}>{incoming && <Pressable style={styles.acceptButton} onPress={acceptCall}><Text style={styles.callActionText}>Answer</Text></Pressable>}<Pressable style={styles.declineButton} onPress={finishCall}><Text style={styles.callActionText}>{incoming ? 'Decline' : 'End call'}</Text></Pressable></View></View></View>;
}

function SecureInput({ value, onChangeText, placeholder, style }: { value: string; onChangeText: (text: string) => void; placeholder: string; style: any }) {
  const [visible, setVisible] = useState(false);
  return <View style={styles.secureInputWrap}><TextInput value={value} onChangeText={onChangeText} secureTextEntry={!visible} autoCapitalize="none" autoCorrect={false} textContentType="password" placeholder={placeholder} placeholderTextColor={MUTED} style={[style, styles.secureInput]} /><Pressable accessibilityRole="button" accessibilityLabel={visible ? 'Hide password' : 'Show password'} onPress={() => setVisible((current) => !current)} style={styles.secureToggle}><Text style={styles.secureToggleText}>{visible ? 'Hide' : 'Show'}</Text></Pressable></View>;
}

function AuthScreen(props: any) {
  return <SafeAreaView style={styles.safe}><StatusBar style="light" /><View style={styles.authViewport}><View style={styles.auth}><View style={styles.brandMark}><Text style={styles.brandMarkText}>B</Text></View><Text style={styles.brand}>B-MESSENGER</Text><Text style={styles.authHeading}>{props.authMode === 'login' ? 'Welcome back' : 'Create your account'}</Text><Text style={styles.authCopy}>Your conversations, ready wherever you are.</Text>{props.authMode === 'register' && <TextInput value={props.fullName} onChangeText={props.setFullName} placeholder="Full name" placeholderTextColor={MUTED} style={styles.authInput} /> }<TextInput value={props.username} onChangeText={props.setUsername} autoCapitalize="none" placeholder="Username" placeholderTextColor={MUTED} style={styles.authInput} /><SecureInput value={props.password} onChangeText={props.setPassword} placeholder="Password" style={styles.authInput} /><Text style={styles.error}>{props.authError}</Text><Pressable style={styles.primary} onPress={props.submitAuth} disabled={props.busy}><Text style={styles.primaryText}>{props.busy ? 'Please wait…' : props.authMode === 'login' ? 'Sign in' : 'Register'}</Text></Pressable><Pressable style={styles.switchButton} onPress={() => { props.setAuthMode(props.authMode === 'login' ? 'register' : 'login'); props.setAuthError(''); }}><Text style={styles.switch}>{props.authMode === 'login' ? 'New to B-MESSENGER? Create an account' : 'Already have an account? Sign in'}</Text></Pressable></View></View></SafeAreaView>;
}

function formatTime(value?: string) { return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: BG }, flex: { flex: 1 }, center: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center' }, authViewport: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }, auth: { width: '100%', maxWidth: 420, backgroundColor: '#11141C', borderRadius: 28, padding: 24, borderWidth: 1, borderColor: '#242938', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 22, shadowOffset: { width: 0, height: 12 } }, brandMark: { width: 48, height: 48, borderRadius: 16, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, brandMarkText: { color: '#FFF', fontSize: 25, fontWeight: '900' }, brand: { color: '#FFF', fontSize: 30, fontWeight: '800', letterSpacing: -0.7 }, authHeading: { color: '#FFF', fontSize: 24, fontWeight: '700', marginTop: 24 }, authCopy: { color: MUTED, fontSize: 15, lineHeight: 22, marginTop: 8, marginBottom: 10 }, authInput: { backgroundColor: PANEL, color: '#FFF', borderRadius: 14, padding: 16, marginTop: 12, fontSize: 16, borderWidth: 1, borderColor: '#242938' }, error: { color: '#FF8F8F', minHeight: 24, marginTop: 10 }, primary: { backgroundColor: BRAND, padding: 17, borderRadius: 14, alignItems: 'center', marginTop: 8 }, primaryText: { color: '#FFF', fontWeight: '700', fontSize: 16 }, switchButton: { paddingVertical: 12 }, switch: { color: '#B9AEFF', textAlign: 'center', marginTop: 10 }, header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#222733' }, headerCopy: { flex: 1, marginLeft: 12 }, title: { color: '#FFF', fontSize: 20, fontWeight: '700' }, subtitle: { color: MUTED, marginTop: 3 }, phoneButton: { width: 38, height: 38, borderRadius: 13, backgroundColor: '#252036', alignItems: 'center', justifyContent: 'center' }, phoneButtonText: { color: '#B9AEFF', fontSize: 18 }, onlineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#39D98A' }, screenHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 20 }, newButton: { width: 38, height: 38, borderRadius: 13, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' }, newButtonText: { color: '#FFF', fontSize: 24, lineHeight: 25 }, sectionTitle: { color: '#FFF', fontSize: 15, fontWeight: '700', paddingHorizontal: 20, paddingVertical: 20 }, list: { paddingHorizontal: 16 }, row: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 16, backgroundColor: PANEL, marginBottom: 10 }, rowCopy: { flex: 1, marginLeft: 12 }, rowTitle: { color: '#FFF', fontSize: 16, fontWeight: '700' }, rowSub: { color: MUTED, marginTop: 5 }, chevron: { color: MUTED, fontSize: 26 }, avatar: { width: 48, height: 48, borderRadius: 16, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' }, avatarSmall: { width: 38, height: 38, borderRadius: 12 }, avatarText: { color: '#FFF', fontWeight: '800', fontSize: 18 }, signOut: { color: '#FF9B9B', fontWeight: '700' }, empty: { color: MUTED, textAlign: 'center', lineHeight: 22, padding: 30 }, statusContent: { padding: 16 }, statusComposer: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 18, backgroundColor: PANEL }, statusPlus: { width: 48, height: 48, borderRadius: 16, borderWidth: 1, borderColor: BRAND, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, statusPlusText: { color: BRAND, fontSize: 26 }, sectionLabel: { color: MUTED, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 28, marginBottom: 12 }, emptyPanel: { alignItems: 'center', paddingHorizontal: 28, paddingTop: 72 }, emptyIcon: { color: BRAND, fontSize: 44, marginBottom: 12 }, emptyTitle: { color: '#FFF', fontSize: 18, fontWeight: '700' }, settingsContent: { padding: 16 }, profileCard: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 18, backgroundColor: PANEL, marginBottom: 16 }, settingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 17, borderBottomWidth: 1, borderBottomColor: '#202532' }, settingIcon: { color: BRAND, fontSize: 18, width: 34 }, settingText: { flex: 1, color: '#FFF', fontSize: 16 }, logoutRow: { alignItems: 'center', paddingVertical: 22 }, logoutText: { color: '#FF9B9B', fontWeight: '700', fontSize: 16 }, version: { color: MUTED, fontSize: 12, textAlign: 'center', marginTop: 12 }, bottomNav: { flexDirection: 'row', backgroundColor: '#11141C', borderTopWidth: 1, borderTopColor: '#242938', paddingTop: 9, paddingBottom: Platform.OS === 'ios' ? 18 : 10 }, navItem: { flex: 1, alignItems: 'center', gap: 3 }, navIcon: { color: MUTED, fontSize: 21 }, navIconActive: { color: BRAND }, navLabel: { color: MUTED, fontSize: 11, fontWeight: '600' }, navLabelActive: { color: '#FFF' }, modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' }, modalCard: { backgroundColor: '#11141C', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 22, borderWidth: 1, borderColor: LINE }, callOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(5, 7, 12, 0.88)', alignItems: 'center', justifyContent: 'center', padding: 24 }, callCard: { width: '100%', maxWidth: 360, alignItems: 'center', backgroundColor: '#181C28', borderRadius: 28, padding: 28, borderWidth: 1, borderColor: '#32384A' }, callTitle: { color: '#FFF', fontSize: 20, fontWeight: '700', marginTop: 18 }, callPeer: { color: '#FFF', fontSize: 26, fontWeight: '800', marginTop: 8 }, callStatus: { color: MUTED, marginTop: 8 }, callActions: { flexDirection: 'row', gap: 12, marginTop: 28 }, acceptButton: { backgroundColor: '#2DBE78', borderRadius: 15, paddingHorizontal: 20, paddingVertical: 14 }, declineButton: { backgroundColor: '#E05B66', borderRadius: 15, paddingHorizontal: 20, paddingVertical: 14 }, callActionText: { color: '#FFF', fontWeight: '700' }, back: { color: '#FFF', fontSize: 38, lineHeight: 34, marginRight: 8 }, messageList: { padding: 16, gap: 10 }, bubble: { padding: 12, borderRadius: 16, maxWidth: '82%' }, myBubble: { backgroundColor: BRAND, alignSelf: 'flex-end', borderBottomRightRadius: 4 }, theirBubble: { backgroundColor: PANEL, alignSelf: 'flex-start', borderBottomLeftRadius: 4 }, messageText: { color: '#FFF', fontSize: 16, lineHeight: 21 }, messageTime: { color: '#D8D3FF', fontSize: 11, marginTop: 5, textAlign: 'right' }, composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, borderTopWidth: 1, borderTopColor: '#222733', gap: 8 }, input: { flex: 1, maxHeight: 100, color: '#FFF', backgroundColor: PANEL, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, fontSize: 16 }, send: { backgroundColor: BRAND, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13 }, sendText: { color: '#FFF', fontWeight: '700' }, secureInputWrap: { position: 'relative', marginTop: 12 }, secureInput: { marginTop: 0, paddingRight: 74 }, secureToggle: { position: 'absolute', right: 8, top: 8, bottom: 8, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' }, secureToggleText: { color: BRAND, fontSize: 12, fontWeight: '800' },  videoStage: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }, remoteVideo: { flex: 1, backgroundColor: '#000' }, localVideo: { position: 'absolute', width: 112, height: 160, right: 18, top: 34, borderRadius: 16, borderWidth: 2, borderColor: BRAND }, callListButton: { width: 38, height: 38, borderRadius: 13, backgroundColor: `${BRAND}24`, alignItems: 'center', justifyContent: 'center', marginLeft: 6 }, videoButton: { width: 34, height: 38, borderRadius: 13, backgroundColor: '#183A5C', alignItems: 'center', justifyContent: 'center', marginLeft: 6 }, attach: { width: 32, height: 38, borderRadius: 12, backgroundColor: PANEL_RAISED, alignItems: 'center', justifyContent: 'center' }, attachText: { color: BRAND, fontSize: 20, fontWeight: '800' }, messageImage: { width: 220, height: 180, borderRadius: 12, marginBottom: 6 }, deletedText: { color: MUTED, fontStyle: 'italic' }, voiceNote: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 160 }, wave: { flexDirection: 'row', alignItems: 'center', gap: 3, flex: 1 }, waveLine: { width: 3, height: 15, borderRadius: 2, backgroundColor: BRAND }, actionCard: { backgroundColor: '#11141C', borderRadius: 24, padding: 22, margin: 22, borderWidth: 1, borderColor: LINE }, actionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: LINE }, cancelAction: { alignItems: 'center', paddingVertical: 16 }, statusViewer: { flex: 1, backgroundColor: '#02040B', alignItems: 'center', justifyContent: 'center', padding: 24 }, viewerClose: { position: 'absolute', top: 44, right: 22, zIndex: 2 }, statusImage: { width: '100%', height: '65%' }, statusViewerText: { color: '#FFF', fontSize: 28, lineHeight: 38, textAlign: 'center', padding: 28 }, statusViewerUser: { color: MUTED, marginTop: 18, fontSize: 15 }, viewerActions: { flexDirection: 'row', gap: 26, marginTop: 24 }, viewerAction: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
});
