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

// In-memory storage with persistence
const users = new Map(); // username -> password
const activeUsers = new Map(); // socket.id -> {username, userId}
const userSockets = new Map(); // username -> socket.id

// Store ALL conversations permanently
const allConversations = new Map(); // conversationId -> [messages]

// Generate conversation ID for two users
function getConversationId(user1, user2) {
    return [user1, user2].sort().join('_');
}

// Get user's conversation partners
function getUserConversations(username) {
    const userConversations = [];
    
    for (const [conversationId, messages] of allConversations) {
        const usersInConv = conversationId.split('_');
        if (usersInConv.includes(username)) {
            const partner = usersInConv.find(user => user !== username);
            if (partner) {
                // Get last message and timestamp
                const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                userConversations.push({
                    partner,
                    lastMessage: lastMessage ? {
                        text: lastMessage.text,
                        timestamp: lastMessage.timestamp,
                        sender: lastMessage.sender
                    } : null,
                    unreadCount: messages.filter(m => m.receiver === username && !m.read).length
                });
            }
        }
    }
    
    return userConversations.sort((a, b) => {
        const timeA = a.lastMessage ? new Date(a.lastMessage.timestamp) : new Date(0);
        const timeB = b.lastMessage ? new Date(b.lastMessage.timestamp) : new Date(0);
        return timeB - timeA; // Most recent first
    });
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

// Get user's conversations
app.get('/user-conversations/:username', (req, res) => {
    const { username } = req.params;
    const conversations = getUserConversations(username);
    res.json({ conversations });
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
        
        // Send user's conversation history
        const userConversations = getUserConversations(username);
        socket.emit('user-conversations', userConversations);
    });

    socket.on('join-conversation', (data) => {
        const { currentUser, targetUser } = data;
        const conversationId = getConversationId(currentUser, targetUser);
        
        // Get conversation messages (create empty array if doesn't exist)
        const conversationMessages = allConversations.get(conversationId) || [];
        
        // Mark messages as read when user opens conversation
        conversationMessages.forEach(message => {
            if (message.receiver === currentUser && !message.read) {
                message.read = true;
            }
        });

        socket.emit('conversation-history', {
            conversationId,
            messages: conversationMessages,
            targetUser: targetUser
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
            conversationId,
            read: false // Initially unread
        };

        // Initialize conversation if it doesn't exist
        if (!allConversations.has(conversationId)) {
            allConversations.set(conversationId, []);
        }

        // Add message to conversation history
        allConversations.get(conversationId).push(message);
        
        // Keep last 1000 messages per conversation (much higher limit)
        if (allConversations.get(conversationId).length > 1000) {
            allConversations.get(conversationId).shift();
        }

        // Send to sender immediately
        socket.emit('new-private-message', message);
        
        // Update sender's conversation list
        const senderConversations = getUserConversations(sender);
        socket.emit('user-conversations', senderConversations);

        // Send to receiver if online
        const receiverSocketId = userSockets.get(receiver);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('new-private-message', message);
            
            // Update receiver's conversation list
            const receiverConversations = getUserConversations(receiver);
            io.to(receiverSocketId).emit('user-conversations', receiverConversations);
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
    console.log(`💾 Conversation persistence: ENABLED`);
});
