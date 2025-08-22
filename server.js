const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}
if (!fs.existsSync('uploads/profiles')) {
    fs.mkdirSync('uploads/profiles');
}

// MongoDB Connection
const MONGODB_URI = 'mongodb+srv://ellyongiro8:QwXDXE6tyrGpUTNb@cluster0.tyxcmm9.mongodb.net/gramx?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log('✅ Connected to MongoDB Atlas');
})
.catch((error) => {
    console.log('❌ MongoDB connection error:', error);
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    profilePicture: { type: String, default: '' },
    bio: { type: String, default: '' },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    phoneNumber: { type: String, default: '' },
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'light' },
    notificationEnabled: { type: Boolean, default: true }
});

const messageSchema = new mongoose.Schema({
    text: { type: String, required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    conversationId: { type: String, required: true },
    messageType: { type: String, enum: ['text', 'image', 'file', 'voice'], default: 'text' },
    fileUrl: { type: String, default: '' },
    read: { type: Boolean, default: false },
    readAt: { type: Date },
    timestamp: { type: Date, default: Date.now },
    edited: { type: Boolean, default: false },
    editedAt: { type: Date }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Multer configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'profilePicture') {
            cb(null, 'uploads/profiles/');
        } else {
            cb(null, 'uploads/');
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

// In-memory for active sessions
const activeUsers = new Map();
const userSockets = new Map();

// Helper functions
function getConversationId(user1, user2) {
    return [user1, user2].sort().join('_');
}

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Routes
app.post('/register', upload.single('profilePicture'), async (req, res) => {
    try {
        const { username, email, password, bio } = req.body;
        
        const existingUser = await User.findOne({ 
            $or: [{ email }, { username }] 
        });
        
        if (existingUser) {
            return res.json({ success: false, error: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const profilePicture = req.file ? `/uploads/profiles/${req.file.filename}` : '';

        const user = new User({
            username,
            email,
            password: hashedPassword,
            profilePicture,
            bio
        });

        await user.save();
        res.json({ success: true, user: { id: user._id, username, email, profilePicture, bio } });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        
        if (!user) {
            return res.json({ success: false, error: 'User not found' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.json({ success: false, error: 'Invalid password' });
        }

        user.isOnline = true;
        user.lastSeen = new Date();
        await user.save();

        res.json({ 
            success: true, 
            user: { 
                id: user._id, 
                username: user.username, 
                email: user.email,
                profilePicture: user.profilePicture,
                bio: user.bio
            } 
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/users', async (req, res) => {
    try {
        const users = await User.find({}, 'username profilePicture isOnline lastSeen bio')
            .sort({ isOnline: -1, username: 1 });
        res.json({ success: true, users });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/conversations/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const conversations = await Message.aggregate([
            {
                $match: {
                    $or: [{ sender: mongoose.Types.ObjectId(userId) }, { receiver: mongoose.Types.ObjectId(userId) }]
                }
            },
            {
                $sort: { timestamp: -1 }
            },
            {
                $group: {
                    _id: "$conversationId",
                    lastMessage: { $first: "$$ROOT" },
                    unreadCount: {
                        $sum: {
                            $cond: [
                                { $and: [
                                    { $eq: ["$receiver", mongoose.Types.ObjectId(userId)] },
                                    { $eq: ["$read", false] }
                                ]},
                                1,
                                0
                            ]
                        }
                    }
                }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "lastMessage.sender",
                    foreignField: "_id",
                    as: "senderInfo"
                }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "lastMessage.receiver",
                    foreignField: "_id",
                    as: "receiverInfo"
                }
            }
        ]);

        res.json({ success: true, conversations });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.json({ success: false, error: 'No file uploaded' });
    }
    res.json({ success: true, url: `/uploads/${req.file.filename}` });
});

app.get('/user/profile', async (req, res) => {
    try {
        const userId = req.query.userId;
        const user = await User.findById(userId).select('-password');
        res.json({ success: true, user });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.put('/user/profile', upload.single('profilePicture'), async (req, res) => {
    try {
        const { userId, username, bio, phoneNumber, theme, notificationEnabled } = req.body;
        const updateData = { username, bio, phoneNumber, theme, notificationEnabled };
        
        if (req.file) {
            updateData.profilePicture = `/uploads/profiles/${req.file.filename}`;
        }

        const user = await User.findByIdAndUpdate(userId, updateData, { new: true }).select('-password');
        res.json({ success: true, user });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/app/info', (req, res) => {
    res.json({
        success: true,
        app: {
            name: 'gramX',
            version: '1.0.0',
            developer: 'Bruce Bera',
            developerContact: '+254743982206',
            website: 'https://gramx.com',
            supportEmail: 'support@gramx.com'
        }
    });
});

// Socket.io handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('user-login', async (userData) => {
        try {
            activeUsers.set(socket.id, userData);
            userSockets.set(userData.id, socket.id);

            await User.findByIdAndUpdate(userData.id, { 
                isOnline: true,
                lastSeen: new Date()
            });

            // Get all users for the user list
            const allUsers = await User.find({}, 'username profilePicture isOnline lastSeen bio')
                .sort({ isOnline: -1, username: 1 });
            
            // Get online users for status updates
            const onlineUsers = allUsers.filter(user => user.isOnline && user._id.toString() !== userData.id);
            
            // Send both all users and online users
            socket.emit('all-users', allUsers);
            socket.emit('online-users', onlineUsers);

            // Send user's conversation history
            const userConversations = await Message.aggregate([
                {
                    $match: {
                        $or: [{ sender: mongoose.Types.ObjectId(userData.id) }, { receiver: mongoose.Types.ObjectId(userData.id) }]
                    }
                },
                {
                    $sort: { timestamp: -1 }
                },
                {
                    $group: {
                        _id: "$conversationId",
                        lastMessage: { $first: "$$ROOT" },
                        unreadCount: {
                            $sum: {
                                $cond: [
                                    { $and: [
                                        { $eq: ["$receiver", mongoose.Types.ObjectId(userData.id)] },
                                        { $eq: ["$read", false] }
                                    ]},
                                    1,
                                    0
                                ]
                            }
                        }
                    }
                }
            ]);

            socket.emit('user-conversations', userConversations);

        } catch (error) {
            console.error('Login error:', error);
        }
    });

    socket.on('join-conversation', async (data) => {
        try {
            const { currentUser, targetUser } = data;
            const conversationId = getConversationId(currentUser.id, targetUser.id);

            const messages = await Message.find({ conversationId })
                .populate('sender', 'username profilePicture')
                .populate('receiver', 'username profilePicture')
                .sort({ timestamp: 1 });

            await Message.updateMany(
                {
                    conversationId,
                    receiver: currentUser.id,
                    read: false
                },
                {
                    read: true,
                    readAt: new Date()
                }
            );

            socket.emit('conversation-history', {
                conversationId,
                messages,
                targetUser
            });

        } catch (error) {
            console.error('Join conversation error:', error);
        }
    });

    socket.on('send-private-message', async (data) => {
        try {
            const { sender, receiver, text, messageType = 'text', fileUrl = '' } = data;
            const conversationId = getConversationId(sender.id, receiver.id);

            const message = new Message({
                text,
                sender: sender.id,
                receiver: receiver.id,
                conversationId,
                messageType,
                fileUrl,
                timestamp: new Date()
            });

            await message.save();
            await message.populate('sender', 'username profilePicture');
            await message.populate('receiver', 'username profilePicture');

            // Send to sender
            socket.emit('new-private-message', message);
            
            // Send to receiver if online
            const receiverSocketId = userSockets.get(receiver.id);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('new-private-message', message);
            }

        } catch (error) {
            console.error('Send message error:', error);
        }
    });

    socket.on('typing-start', (data) => {
        const receiverSocketId = userSockets.get(data.receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('user-typing', {
                senderId: data.senderId,
                senderName: data.senderName
            });
        }
    });

    socket.on('typing-stop', (data) => {
        const receiverSocketId = userSockets.get(data.receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('user-stopped-typing', {
                senderId: data.senderId
            });
        }
    });

    socket.on('disconnect', async () => {
        try {
            const userData = activeUsers.get(socket.id);
            if (userData) {
                activeUsers.delete(socket.id);
                userSockets.delete(userData.id);

                await User.findByIdAndUpdate(userData.id, { 
                    isOnline: false,
                    lastSeen: new Date()
                });

                // Notify all users that this user went offline
                const allUsers = await User.find({}, 'username profilePicture isOnline lastSeen bio');
                io.emit('all-users', allUsers);
                
                const onlineUsers = allUsers.filter(user => user.isOnline);
                io.emit('online-users', onlineUsers);
            }
        } catch (error) {
            console.error('Disconnect error:', error);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 gramX server running on port ${PORT}`);
    console.log(`📱 Open http://localhost:${PORT} in your browser`);
    console.log(`💾 MongoDB Atlas: CONNECTED`);
    console.log(`👨‍💻 Developer: Bruce Bera (+254743982206)`);
});
