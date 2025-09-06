// server.js - GramX Messaging Server
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const cors = require('cors');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gramx', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, unique: true, sparse: true },
  phone: { type: String, unique: true, sparse: true },
  passwordHash: { type: String, required: true },
  profilePhotoUrl: { type: String, default: '' },
  about: { type: String, default: 'Hey there! I\'m using GramX' },
  settings: {
    theme: { type: String, default: 'light' },
    privacy: {
      lastSeen: { type: String, default: 'contacts' },
      profilePhoto: { type: String, default: 'everyone' },
      readReceipts: { type: Boolean, default: true }
    },
    notifications: {
      muteChats: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Chat' }],
      pushEnabled: { type: Boolean, default: true }
    }
  },
  lastSeen: { type: Date, default: Date.now },
  online: { type: Boolean, default: false }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['text', 'image', 'video', 'audio', 'file'], default: 'text' },
  message: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  reactions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    emoji: { type: String }
  }],
  expiresAt: { type: Date },
  isDisappearing: { type: Boolean, default: false }
}, { timestamps: true });

const chatSchema = new mongoose.Schema({
  type: { type: String, enum: ['private', 'group'], default: 'private' },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  name: { type: String, default: '' },
  photoUrl: { type: String, default: '' },
  theme: { type: String, default: '' }
}, { timestamps: true });

const statusSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['image', 'video', 'text'], required: true },
  mediaUrl: { type: String, default: '' },
  caption: { type: String, default: '' },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

// Models
const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Chat = mongoose.model('Chat', chatSchema);
const Status = mongoose.model('Status', statusSchema);

// Cloudinary storage for media uploads
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'gramx',
    format: async (req, file) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) return 'png';
      if (['.mp4', '.mov', '.avi'].includes(ext)) return 'mp4';
      if (['.mp3', '.wav', '.ogg'].includes(ext)) return 'mp3';
      return 'raw';
    },
    public_id: (req, file) => {
      return `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    }
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'gramx_secret');
    const user = await User.findById(decoded.userId).select('-passwordHash');
    if (!user) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Routes

// User registration
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { phone }]
    });

    if (existingUser) {
      return res.status(400).json({ error: 'User with this email or phone already exists' });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const user = new User({
      username,
      email,
      phone,
      passwordHash
    });

    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'gramx_secret',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User created successfully',
      token,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        profilePhotoUrl: user.profilePhotoUrl,
        about: user.about
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  try {
    const { email, phone, password } = req.body;

    // Find user by email or phone
    const user = await User.findOne({
      $or: [{ email }, { phone }]
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Update last seen and online status
    user.lastSeen = new Date();
    user.online = true;
    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'gramx_secret',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        profilePhotoUrl: user.profilePhotoUrl,
        about: user.about,
        online: user.online,
        lastSeen: user.lastSeen
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user profile
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    res.json({
      user: {
        _id: req.user._id,
        username: req.user.username,
        email: req.user.email,
        phone: req.user.phone,
        profilePhotoUrl: req.user.profilePhotoUrl,
        about: req.user.about,
        settings: req.user.settings,
        online: req.user.online,
        lastSeen: req.user.lastSeen
      }
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile
app.put('/api/profile', authenticateToken, upload.single('profilePhoto'), async (req, res) => {
  try {
    const { username, about } = req.body;
    
    if (username) req.user.username = username;
    if (about) req.user.about = about;
    
    if (req.file) {
      req.user.profilePhotoUrl = req.file.path;
    }
    
    await req.user.save();
    
    res.json({
      message: 'Profile updated successfully',
      user: {
        _id: req.user._id,
        username: req.user.username,
        email: req.user.email,
        phone: req.user.phone,
        profilePhotoUrl: req.user.profilePhotoUrl,
        about: req.user.about
      }
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get or create chat
app.post('/api/chats', authenticateToken, async (req, res) => {
  try {
    const { participantId } = req.body;
    
    // Check if chat already exists
    let chat = await Chat.findOne({
      type: 'private',
      participants: { $all: [req.user._id, participantId] }
    }).populate('participants', 'username profilePhotoUrl online lastSeen');
    
    if (!chat) {
      // Create new chat
      chat = new Chat({
        type: 'private',
        participants: [req.user._id, participantId]
      });
      
      await chat.save();
      chat = await Chat.findById(chat._id).populate('participants', 'username profilePhotoUrl online lastSeen');
    }
    
    res.json({ chat });
  } catch (error) {
    console.error('Chat creation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user chats
app.get('/api/chats', authenticateToken, async (req, res) => {
  try {
    const chats = await Chat.find({
      participants: req.user._id
    })
    .populate('participants', 'username profilePhotoUrl online lastSeen')
    .populate('lastMessage')
    .sort({ updatedAt: -1 });
    
    res.json({ chats });
  } catch (error) {
    console.error('Chats fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get chat messages
app.get('/api/chats/:chatId/messages', authenticateToken, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    
    // Check if user is part of the chat
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user._id
    });
    
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    
    const messages = await Message.find({ chatId })
      .populate('senderId', 'username profilePhotoUrl')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    // Mark messages as read
    await Message.updateMany(
      { 
        chatId, 
        senderId: { $ne: req.user._id },
        status: { $in: ['sent', 'delivered'] }
      },
      { status: 'read' }
    );
    
    res.json({ 
      messages: messages.reverse(),
      hasMore: messages.length === limit
    });
  } catch (error) {
    console.error('Messages fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload media
app.post('/api/upload', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    res.json({
      message: 'File uploaded successfully',
      mediaUrl: req.file.path,
      publicId: req.file.filename
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get contacts
app.get('/api/contacts', authenticateToken, async (req, res) => {
  try {
    // In a real app, you might have a contacts system
    // For now, return all users except the current one
    const users = await User.find({
      _id: { $ne: req.user._id }
    }).select('username profilePhotoUrl about online lastSeen');
    
    res.json({ contacts: users });
  } catch (error) {
    console.error('Contacts fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Post a status
app.post('/api/status', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    const { type, caption } = req.body;
    
    if (!type) {
      return res.status(400).json({ error: 'Type is required' });
    }
    
    if (type !== 'text' && !req.file) {
      return res.status(400).json({ error: 'Media is required for non-text status' });
    }
    
    // Calculate expiration time (24 hours from now)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    
    const status = new Status({
      userId: req.user._id,
      type,
      mediaUrl: req.file ? req.file.path : '',
      caption: caption || '',
      expiresAt
    });
    
    await status.save();
    
    // Populate user info
    await status.populate('userId', 'username profilePhotoUrl');
    
    res.json({
      message: 'Status posted successfully',
      status
    });
  } catch (error) {
    console.error('Status post error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get statuses
app.get('/api/statuses', authenticateToken, async (req, res) => {
  try {
    // Get statuses from contacts that haven't expired
    const statuses = await Status.find({
      expiresAt: { $gt: new Date() }
    })
    .populate('userId', 'username profilePhotoUrl')
    .sort({ createdAt: -1 });
    
    res.json({ statuses });
  } catch (error) {
    console.error('Statuses fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket.io for real-time messaging
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'gramx_secret');
    const user = await User.findById(decoded.userId);
    if (!user) {
      return next(new Error('Authentication error'));
    }
    
    socket.userId = user._id;
    next();
  } catch (error) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.userId);
  
  // Update user online status
  User.findByIdAndUpdate(socket.userId, { online: true, lastSeen: new Date() }).exec();
  
  // Join user to their own room for targeted messages
  socket.join(socket.userId.toString());
  
  // Handle sending messages
  socket.on('send_message', async (data) => {
    try {
      const { chatId, receiverId, type, message, mediaUrl, isDisappearing, disappearAfter } = data;
      
      let expiresAt;
      if (isDisappearing && disappearAfter) {
        expiresAt = new Date();
        expiresAt.setSeconds(expiresAt.getSeconds() + disappearAfter);
      }
      
      // Create new message
      const newMessage = new Message({
        chatId,
        senderId: socket.userId,
        receiverId,
        type,
        message,
        mediaUrl,
        isDisappearing: !!isDisappearing,
        expiresAt
      });
      
      await newMessage.save();
      
      // Update chat's last message
      await Chat.findByIdAndUpdate(chatId, {
        lastMessage: newMessage._id,
        updatedAt: new Date()
      });
      
      // Populate sender info
      await newMessage.populate('senderId', 'username profilePhotoUrl');
      
      // Emit to receiver
      socket.to(receiverId.toString()).emit('new_message', newMessage);
      
      // Emit back to sender for confirmation
      socket.emit('message_sent', newMessage);
    } catch (error) {
      console.error('Message send error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  // Handle message reactions
  socket.on('react_to_message', async (data) => {
    try {
      const { messageId, emoji } = data;
      
      const message = await Message.findById(messageId);
      if (!message) {
        return socket.emit('error', { message: 'Message not found' });
      }
      
      // Remove existing reaction from this user
      message.reactions = message.reactions.filter(
        reaction => reaction.userId.toString() !== socket.userId.toString()
      );
      
      // Add new reaction
      if (emoji) {
        message.reactions.push({
          userId: socket.userId,
          emoji
        });
      }
      
      await message.save();
      
      // Emit to all participants in the chat
      const chat = await Chat.findById(message.chatId);
      if (chat) {
        chat.participants.forEach(participantId => {
          io.to(participantId.toString()).emit('message_reacted', {
            messageId,
            reactions: message.reactions
          });
        });
      }
    } catch (error) {
      console.error('Reaction error:', error);
      socket.emit('error', { message: 'Failed to react to message' });
    }
  });
  
  // Handle typing indicators
  socket.on('typing_start', (data) => {
    const { chatId, receiverId } = data;
    socket.to(receiverId.toString()).emit('user_typing', {
      chatId,
      userId: socket.userId
    });
  });
  
  socket.on('typing_stop', (data) => {
    const { chatId, receiverId } = data;
    socket.to(receiverId.toString()).emit('user_stopped_typing', {
      chatId,
      userId: socket.userId
    });
  });
  
  // Handle message status updates
  socket.on('message_delivered', async (data) => {
    try {
      const { messageId } = data;
      
      await Message.findByIdAndUpdate(messageId, { status: 'delivered' });
      
      const message = await Message.findById(messageId);
      if (message) {
        socket.to(message.senderId.toString()).emit('message_status', {
          messageId,
          status: 'delivered'
        });
      }
    } catch (error) {
      console.error('Message status update error:', error);
    }
  });
  
  socket.on('message_read', async (data) => {
    try {
      const { messageId } = data;
      
      await Message.findByIdAndUpdate(messageId, { status: 'read' });
      
      const message = await Message.findById(messageId);
      if (message) {
        socket.to(message.senderId.toString()).emit('message_status', {
          messageId,
          status: 'read'
        });
      }
    } catch (error) {
      console.error('Message status update error:', error);
    }
  });
  
  // Handle disconnect
  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.userId);
    
    // Update user offline status
    await User.findByIdAndUpdate(socket.userId, {
      online: false,
      lastSeen: new Date()
    }).exec();
  });
});

// Cleanup expired messages and statuses
setInterval(async () => {
  try {
    // Delete expired messages
    await Message.deleteMany({
      expiresAt: { $lt: new Date() }
    });
    
    // Delete expired statuses
    await Status.deleteMany({
      expiresAt: { $lt: new Date() }
    });
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Error handling middleware
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`GramX server running on port ${PORT}`);
});
