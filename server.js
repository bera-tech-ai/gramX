const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// In-memory storage
const users = new Map(); // username -> password
const activeUsers = new Map(); // socket.id -> {username, userId}
const userSockets = new Map(); // username -> socket.id

// Store messages by conversation ID
const conversations = new Map(); // conversationId -> [messages]

// Generate conversation ID for two users
function getConversationId(user1, user2) {
    return [user1, user2].sort().join('_');
}

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Routes
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    
    if (users.has(username)) {
        return res.json({ success: false, error: 'Username taken' });
    }
    
    users.set(username, password);
    res.json({ success: true, username });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (users.has(username) && users.get(username) === password) {
        res.json({ success: true, username });
    } else {
        res.json({ success: false, error: 'Invalid credentials' });
    }
});

// Get online users
app.get('/online-users', (req, res) => {
    const onlineUsers = Array.from(activeUsers.values()).map(user => user.username);
    res.json({ users: onlineUsers });
});

// Socket.io handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('user-login', (username) => {
        const userData = { username, userId: socket.id };
        activeUsers.set(socket.id, userData);
        userSockets.set(username, socket.id);
        
        // Notify all users about new online user
        io.emit('user-online', username);
        
        // Send list of online users to the new user
        const onlineUsers = Array.from(activeUsers.values()).map(user => user.username);
        socket.emit('online-users', onlineUsers);
    });

    socket.on('join-conversation', (data) => {
        const conversationId = getConversationId(data.currentUser, data.targetUser);
        const conversationMessages = conversations.get(conversationId) || [];
        socket.emit('conversation-history', {
            conversationId,
            messages: conversationMessages,
            targetUser: data.targetUser
        });
    });

    socket.on('send-private-message', (data) => {
        const { sender, receiver, text } = data;
        const conversationId = getConversationId(sender, receiver);
        
        const message = {
            id: Date.now() + Math.random(),
            text,
            sender,
            receiver,
            timestamp: new Date(),
            conversationId
        };

        // Store message in conversation
        if (!conversations.has(conversationId)) {
            conversations.set(conversationId, []);
        }
        conversations.get(conversationId).push(message);
        
        // Keep last 100 messages per conversation
        if (conversations.get(conversationId).length > 100) {
            conversations.get(conversationId).shift();
        }

        // Send to sender
        socket.emit('new-private-message', message);
        
        // Send to receiver if online
        const receiverSocketId = userSockets.get(receiver);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('new-private-message', message);
        }
    });

    socket.on('disconnect', () => {
        const userData = activeUsers.get(socket.id);
        if (userData) {
            const { username } = userData;
            activeUsers.delete(socket.id);
            userSockets.delete(username);
            io.emit('user-offline', username);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 gramX server running on port ${PORT}`);
    console.log(`📱 Open http://localhost:${PORT} in your browser`);
});
