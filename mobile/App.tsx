import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { io, Socket } from 'socket.io-client';
import { mediaDevices, RTCPeerConnection, RTCIceCandidate, RTCSessionDescription } from './webrtc';

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

type Session = { username: string; token: string };
type Profile = { username: string; displayName?: string; avatar?: string; customAvatar?: string | null };
type Conversation = {
  partner: string;
  profile?: Profile;
  lastMessage?: { text?: string; timestamp?: string; sender?: string };
  unread?: number;
};
type StatusItem = { _id: string; user: string; text: string; timestamp: string; bg?: string; viewedByMe?: boolean; likedByMe?: boolean };
type Message = {
  _id?: string;
  sender: string;
  receiver?: string;
  text?: string;
  timestamp?: string;
  pending?: boolean;
};

type AppTab = 'chats' | 'status' | 'calls' | 'contacts' | 'settings';
type CallState = { callId: string; peer: string; role: 'caller' | 'callee'; state: 'ringing' | 'connecting' | 'connected'; incoming?: boolean };

type SocketReply<T> = { success: boolean; error?: string } & T;

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return (await response.json()) as T;
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
  const [activePartner, setActivePartner] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('chats');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [call, setCall] = useState<CallState | null>(null);
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
      const result = await request<{ success: boolean }>('/session', { method: 'POST', body: JSON.stringify(stored) });
      if (result.success) setSession(stored);
      else await AsyncStorage.removeItem('gramx-session');
      setBooting(false);
    }).catch(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!session) return;
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
      const data = response.notification.request.content.data as { type?: string };
      if (data?.type === 'incoming_call') setActiveTab('calls');
    });
    Notifications.getLastNotificationResponseAsync().then((response) => {
      const data = response?.notification.request.content.data as { type?: string } | undefined;
      if (data?.type === 'incoming_call') setActiveTab('calls');
    }).catch(() => undefined);
    return () => { mounted = false; responseListener.remove(); };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const socket = io(API_URL, { transports: ['websocket'], auth: session });
    socketRef.current = socket;
    socket.on('connect', () => {
      socket.emit('get-active-call', {}, (reply: SocketReply<{ call?: { callId: string; role: 'caller' | 'callee'; peer: string; type: string; state: CallState['state'] } | null }>) => {
        if (!reply.success || !reply.call || reply.call.type !== 'voice') return;
        const restored = { callId: reply.call.callId, peer: reply.call.peer, role: reply.call.role, state: reply.call.state, incoming: reply.call.role === 'callee' && reply.call.state === 'ringing' };
        callRef.current = restored;
        setCall(restored);
      });
    });
    socket.on('new-private-message', (message: Message) => {
      if (message.sender === activePartner || message.receiver === activePartner) {
        setMessages((current) => [...current, message]);
      }
      loadConversations(socket);
    });
    socket.on('message-saved', ({ message }: { message: Message }) => {
      setMessages((current) => current.map((item) => item.pending && item.text === message.text ? message : item));
      loadConversations(socket);
    });
    socket.on('message-delivered', () => loadConversations(socket));
    socket.on('call-incoming', (incoming: { callId: string; from: string; type: string }) => {
      if (incoming.type === 'voice') {
        const next = { callId: incoming.callId, peer: incoming.from, role: 'callee' as const, state: 'ringing' as const, incoming: true };
        callRef.current = next;
        setCall(next);
      }
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
    });
    loadConversations(socket);
    loadContacts();
    loadStatuses(socket);
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
    request<{ success: boolean; error?: string; token?: string; username?: string }>(path, { method: 'POST', body: JSON.stringify(payload) })
      .then(async (result) => {
        if (!result.success) return setAuthError(result.error || 'Could not continue');
        if (authMode === 'register') { setAuthMode('login'); setAuthError('Account created. Sign in to continue.'); return; }
        const next = { username: result.username || username.trim(), token: result.token || '' };
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

  function sendMessage() {
    const text = draft.trim();
    if (!text || !activePartner || !socketRef.current || !session) return;
    setDraft('');
    const pending: Message = { sender: session.username, receiver: activePartner, text, timestamp: new Date().toISOString(), pending: true };
    setMessages((current) => [...current, pending]);
    socketRef.current.emit('send-private-message', { receiver: activePartner, text, tempId: `${Date.now()}` }, (reply: SocketReply<{ message: Message }>) => {
      if (!reply.success) setMessages((current) => current.filter((item) => item !== pending));
    });
  }

  function startVoiceCall(peer: string) {
    if (!socketRef.current || callRef.current) return;
    socketRef.current.emit('call-invite', { to: peer, type: 'voice' }, (reply: SocketReply<{ callId?: string; status?: string }>) => {
      if (!reply.success || !reply.callId || reply.status !== 'ringing') return;
      const next = { callId: reply.callId, peer, role: 'caller' as const, state: 'ringing' as const };
      callRef.current = next;
      setCall(next);
    });
  }

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
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    localStreamRef.current = stream;
    const pc: any = new RTCPeerConnection({ iceServers: iceReply.iceServers || [] });
    peerConnectionRef.current = pc;
    stream.getTracks().forEach((track: any) => pc.addTrack(track, stream));
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
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
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
    pendingSignalsRef.current = [];
    callRef.current = null;
    setCall(null);
  }

  async function signOut() {
    if (session && pushTokenRef.current) await request('/push-token', {
      method: 'DELETE',
      headers: { 'x-username': session.username, 'x-token': session.token },
      body: JSON.stringify({ pushToken: pushTokenRef.current }),
    }).catch(() => undefined);
    if (session) await request('/logout', { method: 'POST', body: JSON.stringify(session) }).catch(() => undefined);
    await AsyncStorage.removeItem('gramx-session');
    pushTokenRef.current = null;
    setSession(null); setActivePartner(null); setMessages([]);
  }

  if (booting) return <View style={styles.center}><ActivityIndicator color={BRAND} /></View>;
  if (!session) return <AuthScreen {...{ authMode, setAuthMode, username, setUsername, password, setPassword, fullName, setFullName, authError, busy, submitAuth }} />;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      {activePartner ? (
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}><Pressable onPress={() => setActivePartner(null)}><Text style={styles.back}>‹</Text></Pressable><Avatar name={activeTitle} small /><View style={styles.headerCopy}><Text style={styles.title}>{activeTitle}</Text><Text style={styles.subtitle}>Private chat</Text></View><Pressable style={styles.phoneButton} onPress={() => startVoiceCall(activeTitle)}><Text style={styles.phoneButtonText}>☎</Text></Pressable></View>
          <FlatList data={messages} keyExtractor={(item, index) => item._id || `${item.timestamp}-${index}`} contentContainerStyle={styles.messageList} renderItem={({ item }) => <View style={[styles.bubble, item.sender === session.username ? styles.myBubble : styles.theirBubble]}><Text style={styles.messageText}>{item.text}</Text><Text style={styles.messageTime}>{item.pending ? 'Sending…' : formatTime(item.timestamp)}</Text></View>} />
          <View style={styles.composer}><TextInput value={draft} onChangeText={setDraft} placeholder="Write a message" placeholderTextColor={MUTED} style={styles.input} multiline /><Pressable style={styles.send} onPress={sendMessage}><Text style={styles.sendText}>Send</Text></Pressable></View>
        </KeyboardAvoidingView>
      ) : (
        <View style={styles.flex}>
          {activeTab === 'chats' && <ChatsScreen session={session} conversations={conversations} openConversation={openConversation} />}
          {activeTab === 'status' && <StatusScreen statuses={statuses} addStatus={(text) => socketRef.current?.emit('add-status', { text }, () => loadStatuses())} />}
          {activeTab === 'calls' && <CallsScreen conversations={conversations} startVoiceCall={startVoiceCall} />}
          {activeTab === 'contacts' && <ContactsScreen contacts={contacts} openConversation={openConversation} startVoiceCall={startVoiceCall} />}
          {activeTab === 'settings' && <SettingsScreen username={session.username} signOut={signOut} />}
          <BottomNav activeTab={activeTab} setActiveTab={setActiveTab} />
        </View>
      )}
      {call && <CallOverlay call={call} acceptCall={acceptCall} finishCall={() => finishCall(true)} />}
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

function ChatsScreen({ session, conversations, openConversation }: { session: Session; conversations: Conversation[]; openConversation: (partner: string) => void }) {
  const [query, setQuery] = useState('');
  const visible = conversations.filter((item) => (item.profile?.displayName || item.partner).toLowerCase().includes(query.toLowerCase()));
  return <View style={styles.flex}>
    <Header title="B-MESSENGER" subtitle={`Chat  ·  Connect  ·  Always`} action={<View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: GREEN }} />} />
    <View style={{ paddingHorizontal: 18, paddingTop: 18, paddingBottom: 10 }}><Text style={{ color: '#FFF', fontSize: 27, fontWeight: '800' }}>Messages</Text><Text style={{ color: MUTED, marginTop: 4 }}>Stay close to the people who matter.</Text></View>
    <View style={{ marginHorizontal: 18, marginBottom: 14, backgroundColor: PANEL, borderRadius: 13, borderWidth: 1, borderColor: LINE, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13 }}><Text style={{ color: BRAND, fontSize: 18 }}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder="Search chats" placeholderTextColor={MUTED} style={{ flex: 1, color: '#FFF', paddingVertical: 12, paddingHorizontal: 9 }} /></View>
    <View style={{ flexDirection: 'row', paddingHorizontal: 18, paddingBottom: 10, gap: 9 }}><View style={{ backgroundColor: BRAND, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14 }}><Text style={{ color: '#041326', fontWeight: '800', fontSize: 12 }}>CHATS</Text></View><Text style={{ color: MUTED, fontWeight: '800', fontSize: 12, paddingVertical: 7 }}>GROUPS</Text><Text style={{ color: MUTED, fontWeight: '800', fontSize: 12, paddingVertical: 7 }}>ARCHIVED</Text></View>
    <FlatList data={visible} keyExtractor={(item) => item.partner} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 18 }} ListEmptyComponent={<Text style={styles.empty}>No conversations yet. Open Contacts to start a chat.</Text>} renderItem={({ item }) => <Pressable style={{ flexDirection: 'row', alignItems: 'center', padding: 13, borderRadius: 17, backgroundColor: PANEL, marginBottom: 9, borderWidth: 1, borderColor: LINE }} onPress={() => openConversation(item.partner)}><Avatar name={item.profile?.displayName || item.partner} /><View style={{ flex: 1, marginLeft: 12 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={styles.rowTitle}>{item.profile?.displayName || item.partner}</Text><Text style={{ color: MUTED, fontSize: 11 }}>{item.lastMessage?.timestamp ? formatTime(item.lastMessage.timestamp) : ''}</Text></View><Text style={styles.rowSub} numberOfLines={1}>{item.lastMessage?.text || 'Start a conversation'}</Text></View>{(item.unread || 0) > 0 && <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center', marginLeft: 7 }}><Text style={{ color: '#041326', fontSize: 11, fontWeight: '800' }}>{item.unread}</Text></View>}</Pressable>} />
  </View>;
}

function StatusScreen({ statuses, addStatus }: { statuses: StatusItem[]; addStatus: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  function publish() { const text = draft.trim(); if (!text) return; addStatus(text); setDraft(''); }
  return <View style={styles.flex}><Header title="Status" subtitle="Share a moment with your contacts" action={<Pressable style={styles.newButton} onPress={publish}><Text style={styles.newButtonText}>↑</Text></Pressable>} /><View style={{ margin: 18, padding: 14, borderRadius: 18, backgroundColor: PANEL, borderWidth: 1, borderColor: LINE }}><Text style={{ color: '#FFF', fontSize: 15, fontWeight: '800', marginBottom: 9 }}>My Status</Text><View style={{ flexDirection: 'row', alignItems: 'center' }}><View style={{ width: 38, height: 38, borderRadius: 13, borderWidth: 1, borderColor: BRAND, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: BRAND, fontSize: 22 }}>＋</Text></View><TextInput value={draft} onChangeText={setDraft} onSubmitEditing={publish} placeholder="Share a thought..." placeholderTextColor={MUTED} style={{ flex: 1, color: '#FFF', marginLeft: 10, paddingVertical: 9 }} returnKeyType="send" /></View></View><FlatList data={statuses} keyExtractor={(item) => item._id} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 20 }} ListHeaderComponent={<Text style={{ color: MUTED, fontSize: 12, fontWeight: '800', letterSpacing: 1, marginBottom: 10 }}>RECENT UPDATES</Text>} ListEmptyComponent={<View style={{ alignItems: 'center', paddingTop: 55 }}><Text style={{ color: BRAND, fontSize: 40 }}>◌</Text><Text style={{ color: '#FFF', fontSize: 18, fontWeight: '800', marginTop: 12 }}>No recent updates</Text><Text style={styles.empty}>Your contacts’ status updates will appear here.</Text></View>} renderItem={({ item }) => <Pressable style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: LINE }}><Avatar name={item.user} ring accent={item.bg || BRAND} /><View style={{ marginLeft: 13, flex: 1 }}><Text style={styles.rowTitle}>{item.user}</Text><Text style={styles.rowSub} numberOfLines={1}>{item.text || 'Photo status'}</Text></View><Text style={{ color: MUTED, fontSize: 11 }}>{item.viewedByMe ? 'Viewed' : 'New'}</Text></Pressable>} /></View>;
}

function CallsScreen({ conversations, startVoiceCall }: { conversations: Conversation[]; startVoiceCall: (peer: string) => void }) {
  return <View style={styles.flex}><Header title="Calls" subtitle="Voice and video, closer than ever" action={<Pressable style={styles.newButton}><Text style={styles.newButtonText}>＋</Text></Pressable>} /><FlatList data={conversations.slice(0, 4)} keyExtractor={(item) => item.partner} contentContainerStyle={{ padding: 18 }} ListHeaderComponent={<Text style={{ color: '#FFF', fontSize: 22, fontWeight: '800', marginBottom: 14 }}>Recent calls</Text>} ListEmptyComponent={<Text style={styles.empty}>Your recent calls will appear here.</Text>} renderItem={({ item, index }) => <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: LINE }}><Avatar name={item.profile?.displayName || item.partner} /><View style={{ flex: 1, marginLeft: 12 }}><Text style={styles.rowTitle}>{item.profile?.displayName || item.partner}</Text><Text style={styles.rowSub}>{index === 0 ? 'Outgoing voice call · Today' : 'Incoming voice call · Yesterday'}</Text></View><Pressable onPress={() => startVoiceCall(item.partner)} style={{ width: 38, height: 38, borderRadius: 13, backgroundColor: `${BRAND}24`, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: BRAND, fontSize: 18 }}>☎</Text></Pressable></View>} /></View>;
}

function ContactsScreen({ contacts, openConversation, startVoiceCall }: { contacts: Profile[]; openConversation: (partner: string) => void; startVoiceCall: (peer: string) => void }) {
  const [query, setQuery] = useState('');
  const visible = contacts.filter((item) => (item.displayName || item.username).toLowerCase().includes(query.toLowerCase()));
  return <View style={styles.flex}><Header title="Contacts" subtitle={`${contacts.length} people on B-MESSENGER`} action={<Pressable style={styles.newButton}><Text style={styles.newButtonText}>＋</Text></Pressable>} /><View style={{ margin: 18, marginBottom: 8, backgroundColor: PANEL, borderRadius: 13, borderWidth: 1, borderColor: LINE, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13 }}><Text style={{ color: BRAND, fontSize: 18 }}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder="Search contacts" placeholderTextColor={MUTED} style={{ flex: 1, color: '#FFF', paddingVertical: 12, paddingHorizontal: 9 }} /></View><FlatList data={visible} keyExtractor={(item) => item.username} contentContainerStyle={{ paddingHorizontal: 18 }} ListEmptyComponent={<Text style={styles.empty}>No contacts match your search.</Text>} renderItem={({ item }) => <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: LINE }}><Avatar name={item.displayName || item.username} /><View style={{ flex: 1, marginLeft: 12 }}><Text style={styles.rowTitle}>{item.displayName || item.username}</Text><Text style={styles.rowSub}>@{item.username} · Available to chat</Text></View><Pressable onPress={() => openConversation(item.username)} style={{ padding: 9 }}><Text style={{ color: BRAND, fontSize: 18 }}>▣</Text></Pressable><Pressable onPress={() => startVoiceCall(item.username)} style={{ padding: 9 }}><Text style={{ color: BRAND, fontSize: 18 }}>☎</Text></Pressable></View>} /></View>;
}

function SettingsScreen({ username, signOut }: { username: string; signOut: () => void }) {
  const rows = [['◉', 'Account', 'Profile, name and about'], ['◌', 'Privacy', 'Last seen and read receipts'], ['◈', 'Notifications', 'Messages, calls and status'], ['✦', 'Appearance', 'Dark theme · B-Messenger blue'], ['⌁', 'Chat settings', 'Wallpaper and message preferences'], ['?', 'Help & support', 'Get help with B-Messenger']];
  return <View style={styles.flex}><Header title="Settings" subtitle="Make B-MESSENGER yours" /><ScrollView contentContainerStyle={{ padding: 18 }}><View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 18, backgroundColor: PANEL, borderWidth: 1, borderColor: LINE, marginBottom: 18 }}><Avatar name={username} size={58} ring /><View style={{ marginLeft: 13, flex: 1 }}><Text style={{ color: '#FFF', fontSize: 19, fontWeight: '800' }}>{username}</Text><Text style={styles.rowSub}>Your B-MESSENGER account</Text></View><Text style={{ color: BRAND, fontSize: 23 }}>›</Text></View>{rows.map(([icon, title, sub]) => <Pressable key={title} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: LINE }}><Text style={{ color: BRAND, fontSize: 18, width: 33 }}>{icon}</Text><View style={{ flex: 1 }}><Text style={{ color: '#FFF', fontSize: 15, fontWeight: '700' }}>{title}</Text><Text style={{ color: MUTED, fontSize: 12, marginTop: 3 }}>{sub}</Text></View><Text style={{ color: MUTED, fontSize: 23 }}>›</Text></Pressable>)}<Pressable style={{ alignItems: 'center', paddingVertical: 22 }} onPress={signOut}><Text style={{ color: '#FF9B9B', fontWeight: '800' }}>Sign out</Text></Pressable><Text style={{ color: MUTED, fontSize: 12, textAlign: 'center', marginTop: 8 }}>B-MESSENGER mobile · v1.0</Text></ScrollView></View>;
}

function BottomNav({ activeTab, setActiveTab }: { activeTab: AppTab; setActiveTab: (tab: AppTab) => void }) {
  const items: { key: AppTab; label: string; icon: string }[] = [{ key: 'chats', label: 'Chats', icon: '◒' }, { key: 'status', label: 'Status', icon: '◌' }, { key: 'calls', label: 'Calls', icon: '⌁' }, { key: 'contacts', label: 'Contacts', icon: '♧' }, { key: 'settings', label: 'Settings', icon: '⚙' }];
  return <View style={styles.bottomNav}>{items.map((item) => <Pressable key={item.key} style={styles.navItem} onPress={() => setActiveTab(item.key)}><Text style={[styles.navIcon, activeTab === item.key && styles.navIconActive]}>{item.icon}</Text><Text style={[styles.navLabel, activeTab === item.key && styles.navLabelActive]}>{item.label}</Text></Pressable>)}</View>;
}

function CallOverlay({ call, acceptCall, finishCall }: { call: CallState; acceptCall: () => void; finishCall: () => void }) {
  const incoming = call.incoming && call.state === 'ringing';
  return <View style={styles.callOverlay}><View style={styles.callCard}><Avatar name={call.peer} /><Text style={styles.callTitle}>{incoming ? 'Incoming voice call' : call.state === 'connected' ? 'Voice call' : 'Calling…'}</Text><Text style={styles.callPeer}>{call.peer}</Text><Text style={styles.callStatus}>{call.state === 'connected' ? 'Connected' : incoming ? 'B-MESSENGER voice call' : 'Waiting for answer'}</Text><View style={styles.callActions}>{incoming && <Pressable style={styles.acceptButton} onPress={acceptCall}><Text style={styles.callActionText}>Answer</Text></Pressable>}<Pressable style={styles.declineButton} onPress={finishCall}><Text style={styles.callActionText}>{incoming ? 'Decline' : 'End call'}</Text></Pressable></View></View></View>;
}

function AuthScreen(props: any) {
  return <SafeAreaView style={styles.safe}><StatusBar style="light" /><View style={styles.authViewport}><View style={styles.auth}><View style={styles.brandMark}><Text style={styles.brandMarkText}>B</Text></View><Text style={styles.brand}>B-MESSENGER</Text><Text style={styles.authHeading}>{props.authMode === 'login' ? 'Welcome back' : 'Create your account'}</Text><Text style={styles.authCopy}>Your conversations, ready wherever you are.</Text>{props.authMode === 'register' && <TextInput value={props.fullName} onChangeText={props.setFullName} placeholder="Full name" placeholderTextColor={MUTED} style={styles.authInput} /> }<TextInput value={props.username} onChangeText={props.setUsername} autoCapitalize="none" placeholder="Username" placeholderTextColor={MUTED} style={styles.authInput} /><TextInput value={props.password} onChangeText={props.setPassword} secureTextEntry placeholder="Password" placeholderTextColor={MUTED} style={styles.authInput} /><Text style={styles.error}>{props.authError}</Text><Pressable style={styles.primary} onPress={props.submitAuth} disabled={props.busy}><Text style={styles.primaryText}>{props.busy ? 'Please wait…' : props.authMode === 'login' ? 'Sign in' : 'Register'}</Text></Pressable><Pressable style={styles.switchButton} onPress={() => { props.setAuthMode(props.authMode === 'login' ? 'register' : 'login'); props.setAuthError(''); }}><Text style={styles.switch}>{props.authMode === 'login' ? 'New to B-MESSENGER? Create an account' : 'Already have an account? Sign in'}</Text></Pressable></View></View></SafeAreaView>;
}

function formatTime(value?: string) { return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: BG }, flex: { flex: 1 }, center: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center' }, authViewport: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }, auth: { width: '100%', maxWidth: 420, backgroundColor: '#11141C', borderRadius: 28, padding: 24, borderWidth: 1, borderColor: '#242938', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 22, shadowOffset: { width: 0, height: 12 } }, brandMark: { width: 48, height: 48, borderRadius: 16, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, brandMarkText: { color: '#FFF', fontSize: 25, fontWeight: '900' }, brand: { color: '#FFF', fontSize: 30, fontWeight: '800', letterSpacing: -0.7 }, authHeading: { color: '#FFF', fontSize: 24, fontWeight: '700', marginTop: 24 }, authCopy: { color: MUTED, fontSize: 15, lineHeight: 22, marginTop: 8, marginBottom: 10 }, authInput: { backgroundColor: PANEL, color: '#FFF', borderRadius: 14, padding: 16, marginTop: 12, fontSize: 16, borderWidth: 1, borderColor: '#242938' }, error: { color: '#FF8F8F', minHeight: 24, marginTop: 10 }, primary: { backgroundColor: BRAND, padding: 17, borderRadius: 14, alignItems: 'center', marginTop: 8 }, primaryText: { color: '#FFF', fontWeight: '700', fontSize: 16 }, switchButton: { paddingVertical: 12 }, switch: { color: '#B9AEFF', textAlign: 'center', marginTop: 10 }, header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#222733' }, headerCopy: { flex: 1, marginLeft: 12 }, title: { color: '#FFF', fontSize: 20, fontWeight: '700' }, subtitle: { color: MUTED, marginTop: 3 }, phoneButton: { width: 38, height: 38, borderRadius: 13, backgroundColor: '#252036', alignItems: 'center', justifyContent: 'center' }, phoneButtonText: { color: '#B9AEFF', fontSize: 18 }, onlineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#39D98A' }, screenHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 20 }, newButton: { width: 38, height: 38, borderRadius: 13, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' }, newButtonText: { color: '#FFF', fontSize: 24, lineHeight: 25 }, sectionTitle: { color: '#FFF', fontSize: 15, fontWeight: '700', paddingHorizontal: 20, paddingVertical: 20 }, list: { paddingHorizontal: 16 }, row: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 16, backgroundColor: PANEL, marginBottom: 10 }, rowCopy: { flex: 1, marginLeft: 12 }, rowTitle: { color: '#FFF', fontSize: 16, fontWeight: '700' }, rowSub: { color: MUTED, marginTop: 5 }, chevron: { color: MUTED, fontSize: 26 }, avatar: { width: 48, height: 48, borderRadius: 16, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' }, avatarSmall: { width: 38, height: 38, borderRadius: 12 }, avatarText: { color: '#FFF', fontWeight: '800', fontSize: 18 }, signOut: { color: '#FF9B9B', fontWeight: '700' }, empty: { color: MUTED, textAlign: 'center', lineHeight: 22, padding: 30 }, statusContent: { padding: 16 }, statusComposer: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 18, backgroundColor: PANEL }, statusPlus: { width: 48, height: 48, borderRadius: 16, borderWidth: 1, borderColor: BRAND, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, statusPlusText: { color: BRAND, fontSize: 26 }, sectionLabel: { color: MUTED, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 28, marginBottom: 12 }, emptyPanel: { alignItems: 'center', paddingHorizontal: 28, paddingTop: 72 }, emptyIcon: { color: BRAND, fontSize: 44, marginBottom: 12 }, emptyTitle: { color: '#FFF', fontSize: 18, fontWeight: '700' }, settingsContent: { padding: 16 }, profileCard: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 18, backgroundColor: PANEL, marginBottom: 16 }, settingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 17, borderBottomWidth: 1, borderBottomColor: '#202532' }, settingIcon: { color: BRAND, fontSize: 18, width: 34 }, settingText: { flex: 1, color: '#FFF', fontSize: 16 }, logoutRow: { alignItems: 'center', paddingVertical: 22 }, logoutText: { color: '#FF9B9B', fontWeight: '700', fontSize: 16 }, version: { color: MUTED, fontSize: 12, textAlign: 'center', marginTop: 12 }, bottomNav: { flexDirection: 'row', backgroundColor: '#11141C', borderTopWidth: 1, borderTopColor: '#242938', paddingTop: 9, paddingBottom: Platform.OS === 'ios' ? 18 : 10 }, navItem: { flex: 1, alignItems: 'center', gap: 3 }, navIcon: { color: MUTED, fontSize: 21 }, navIconActive: { color: BRAND }, navLabel: { color: MUTED, fontSize: 11, fontWeight: '600' }, navLabelActive: { color: '#FFF' }, callOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(5, 7, 12, 0.88)', alignItems: 'center', justifyContent: 'center', padding: 24 }, callCard: { width: '100%', maxWidth: 360, alignItems: 'center', backgroundColor: '#181C28', borderRadius: 28, padding: 28, borderWidth: 1, borderColor: '#32384A' }, callTitle: { color: '#FFF', fontSize: 20, fontWeight: '700', marginTop: 18 }, callPeer: { color: '#FFF', fontSize: 26, fontWeight: '800', marginTop: 8 }, callStatus: { color: MUTED, marginTop: 8 }, callActions: { flexDirection: 'row', gap: 12, marginTop: 28 }, acceptButton: { backgroundColor: '#2DBE78', borderRadius: 15, paddingHorizontal: 20, paddingVertical: 14 }, declineButton: { backgroundColor: '#E05B66', borderRadius: 15, paddingHorizontal: 20, paddingVertical: 14 }, callActionText: { color: '#FFF', fontWeight: '700' }, back: { color: '#FFF', fontSize: 38, lineHeight: 34, marginRight: 8 }, messageList: { padding: 16, gap: 10 }, bubble: { padding: 12, borderRadius: 16, maxWidth: '82%' }, myBubble: { backgroundColor: BRAND, alignSelf: 'flex-end', borderBottomRightRadius: 4 }, theirBubble: { backgroundColor: PANEL, alignSelf: 'flex-start', borderBottomLeftRadius: 4 }, messageText: { color: '#FFF', fontSize: 16, lineHeight: 21 }, messageTime: { color: '#D8D3FF', fontSize: 11, marginTop: 5, textAlign: 'right' }, composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, borderTopWidth: 1, borderTopColor: '#222733', gap: 8 }, input: { flex: 1, maxHeight: 100, color: '#FFF', backgroundColor: PANEL, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, fontSize: 16 }, send: { backgroundColor: BRAND, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13 }, sendText: { color: '#FFF', fontWeight: '700' },
});
