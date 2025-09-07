const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { body, validationResult } = require('express-validator');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Enable trust proxy for rate limiting behind proxies
app.set('trust proxy', 1);

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      mediaSrc: ["'self'", "data:", "https:", "blob:"]
    }
  }
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting with proxy support
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/gramx';
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.log(err));

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },
  email: { type: String, unique: true, sparse: true, lowercase: true },
  phone: { type: String, unique: true, sparse: true },
  passwordHash: { type: String, required: true },
  profilePhotoUrl: { type: String, default: '' },
  about: { type: String, default: 'Hey there! I\'m using GramX' },
  settings: {
    theme: { type: String, default: 'dark' },
    privacy: {
      lastSeen: { type: String, default: 'contacts' },
      profilePhoto: { type: String, default: 'everyone' },
      readReceipts: { type: Boolean, default: true }
    },
    notifications: {
      muteChats: { type: Array, default: [] },
      pushEnabled: { type: Boolean, default: true }
    }
  },
  lastSeen: { type: Date, default: Date.now },
  isOnline: { type: Boolean, default: false },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

// Message Schema
const messageSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, default: 'text' },
  message: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
  status: { type: String, default: 'sent' },
  reactions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    emoji: { type: String }
  }],
  disappearing: {
    isActive: { type: Boolean, default: false },
    duration: { type: Number, default: 0 }
  },
  deleted: { type: Boolean, default: false }
});

// Status Schema (Stories)
const statusSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true },
  mediaUrl: { type: String, required: true },
  caption: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  views: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});

// Chat Schema
const chatSchema = new mongoose.Schema({
  type: { type: String, default: 'private' },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  lastMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  updatedAt: { type: Date, default: Date.now },
  isGroup: { type: Boolean, default: false },
  groupName: { type: String, default: '' },
  groupPhoto: { type: String, default: '' },
  groupAdmins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Status = mongoose.model('Status', statusSchema);
const Chat = mongoose.model('Chat', chatSchema);

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

// Validation middleware
const validateRegistration = [
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('email').optional().isEmail().withMessage('Please provide a valid email'),
  body('phone').optional().isMobilePhone().withMessage('Please provide a valid phone number'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
];

// Clean up expired statuses every hour
cron.schedule('0 * * * *', async () => {
  try {
    const result = await Status.deleteMany({ expiresAt: { $lt: new Date() } });
    console.log(`Cleaned up ${result.deletedCount} expired statuses`);
  } catch (error) {
    console.error('Error cleaning up expired statuses:', error);
  }
});

// Routes
app.post('/api/register', validateRegistration, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, email, phone, password } = req.body;
    
    if (!email && !phone) {
      return res.status(400).json({ error: 'Email or phone number is required' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    // Check if user exists
    const existingUser = await User.findOne({
      $or: [{ email }, { phone }]
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const newUser = new User({
      username,
      email: email || null,
      phone: phone || null,
      passwordHash
    });

    await newUser.save();

    // Generate JWT
    const token = jwt.sign(
      { userId: newUser._id },
      process.env.JWT_SECRET || 'gramx_secret',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User created successfully',
      token,
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        phone: newUser.phone,
        profilePhotoUrl: newUser.profilePhotoUrl,
        about: newUser.about
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}); 
app.post('/api/login', async (req, res) => {
  try {
    const { email, phone, password } = req.body;
    
    // Validate input
    if (!password || (!email && !phone)) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    // Find user
    const user = await User.findOne({
      $or: [{ email }, { phone }]
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if passwordHash exists
    if (!user.passwordHash) {
      return res.status(500).json({ error: 'Account error. Please contact support.' });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'gramx_secret',
      { expiresIn: '7d' }
    );

    // Update last seen and online status
    user.lastSeen = new Date();
    user.isOnline = true;
    await user.save();

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        profilePhotoUrl: user.profilePhotoUrl,
        about: user.about,
        settings: user.settings,
        isOnline: user.isOnline
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/logout', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    user.isOnline = false;
    user.lastSeen = new Date();
    await user.save();
    
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/user/:id', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-passwordHash')
      .populate('contacts', 'username profilePhotoUrl about isOnline lastSeen');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check privacy settings
    if (req.user._id.toString() !== user._id.toString()) {
      if (user.settings.privacy.profilePhoto === 'contacts' && 
          !user.contacts.includes(req.user._id)) {
        user.profilePhotoUrl = '';
      }
    }
    
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/search', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query || query.length < 3) {
      return res.status(400).json({ error: 'Search query must be at least 3 characters' });
    }
    
    const users = await User.find({
      $or: [
        { username: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } },
        { phone: { $regex: query, $options: 'i' } }
      ],
      _id: { $ne: req.user._id }
    }).select('username profilePhotoUrl about isOnline lastSeen');
    
    res.json(users);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const { username, about, profilePhotoUrl, settings } = req.body;
    const user = await User.findById(req.user._id);
    
    if (username) user.username = username;
    if (about) user.about = about;
    if (profilePhotoUrl) user.profilePhotoUrl = profilePhotoUrl;
    if (settings) user.settings = { ...user.settings, ...settings };
    
    await user.save();
    
    res.json({
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        username: user.username,
        profilePhotoUrl: user.profilePhotoUrl,
        about: user.about,
        settings: user.settings
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/api/chats', authenticateToken, async (req, res) => {
  try {
    const chats = await Chat.find({
      participants: req.user._id
    })
    .populate('participants', 'username profilePhotoUrl about isOnline lastSeen')
    .populate('lastMessageId')
    .sort({ updatedAt: -1 });
    
    res.json(chats);
  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user._id;
    
    // Check if user is blocked
    const receiver = await User.findById(userId);
    if (receiver.blockedUsers.includes(currentUserId)) {
      return res.status(403).json({ error: 'You are blocked by this user' });
    }
    
    const messages = await Message.find({
      $or: [
        { senderId: currentUserId, receiverId: userId },
        { senderId: userId, receiverId: currentUserId }
      ],
      deleted: false
    })
    .sort({ timestamp: 1 })
    .populate('senderId', 'username profilePhotoUrl')
    .populate('receiverId', 'username profilePhotoUrl');
    
    res.json(messages);
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/message/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // Only allow sender to delete message
    if (message.senderId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }
    
    message.deleted = true;
    await message.save();
    
    // Notify the other user
    const receiverId = message.receiverId.toString();
    io.to(receiverId).emit('messageDeleted', { messageId });
    
    res.json({ message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/upload', authenticateToken, async (req, res) => {
  try {
    if (!req.body.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    // Upload to Cloudinary
    const uploadResponse = await cloudinary.uploader.upload(req.body.file, {
      folder: 'gramx',
      resource_type: 'auto'
    });
    
    res.json({ url: uploadResponse.secure_url });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'File upload failed' });
  }
});

app.post('/api/contacts/add', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    const userToAdd = await User.findById(userId);
    if (!userToAdd) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const currentUser = await User.findById(req.user._id);
    
    if (!currentUser.contacts.includes(userId)) {
      currentUser.contacts.push(userId);
      await currentUser.save();
    }
    
    res.json({ message: 'Contact added successfully', contact: userToAdd });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Join user's room
  socket.on('join', async (userId) => {
    socket.join(userId);
    
    // Update user online status
    await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });
    
    // Notify contacts that user is online
    const user = await User.findById(userId).populate('contacts');
    user.contacts.forEach(contact => {
      socket.to(contact._id.toString()).emit('userOnline', { userId });
    });
    
    console.log(`User ${userId} joined room`);
  });
  
  // Handle sending messages
  socket.on('sendMessage', async (data) => {
    try {
      const { senderId, receiverId, message, type, mediaUrl, disappearing } = data;
      
      // Check if sender is blocked by receiver
      const receiver = await User.findById(receiverId);
      if (receiver.blockedUsers.includes(senderId)) {
        socket.emit('error', { message: 'You are blocked by this user' });
        return;
      }
      
      // Create new message
      const newMessage = new Message({
        chatId: `${senderId}-${receiverId}`,
        senderId,
        receiverId,
        type: type || 'text',
        message,
        mediaUrl: mediaUrl || '',
        status: 'sent',
        disappearing: disappearing || { isActive: false, duration: 0 }
      });
      
      await newMessage.save();
      
      // Populate sender info
      await newMessage.populate('senderId', 'username profilePhotoUrl');
      await newMessage.populate('receiverId', 'username profilePhotoUrl');
      
      // Emit to sender
      socket.emit('messageSent', newMessage);
      
      // Emit to receiver if online
      const receiverSocket = io.sockets.adapter.rooms.get(receiverId);
      if (receiverSocket && receiverSocket.size > 0) {
        newMessage.status = 'delivered';
        await newMessage.save();
        
        socket.to(receiverId).emit('newMessage', newMessage);
      }
      
      // Update chat last message
      let chat = await Chat.findOne({
        participants: { $all: [senderId, receiverId] }
      });
      
      if (chat) {
        chat.lastMessageId = newMessage._id;
        chat.updatedAt = new Date();
        await chat.save();
      } else {
        chat = new Chat({
          type: 'private',
          participants: [senderId, receiverId],
          lastMessageId: newMessage._id
        });
        await chat.save();
        
        // Populate and emit new chat to both users
        await chat.populate('participants', 'username profilePhotoUrl about isOnline lastSeen');
        await chat.populate('lastMessageId');
        
        socket.emit('newChat', chat);
        socket.to(receiverId).emit('newChat', chat);
      }
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  // Handle message status updates
  socket.on('messageStatus', async (data) => {
    try {
      const { messageId, status } = data;
      
      const message = await Message.findByIdAndUpdate(
        messageId,
        { status },
        { new: true }
      ).populate('senderId', 'username profilePhotoUrl');
      
      if (message) {
        // Notify sender about status update
        socket.to(message.senderId._id.toString()).emit('messageStatusUpdate', {
          messageId,
          status
        });
      }
    } catch (error) {
      console.error('Message status error:', error);
    }
  });
  
  // Handle message reactions
  socket.on('messageReaction', async (data) => {
    try {
      const { messageId, userId, emoji } = data;
      
      const message = await Message.findById(messageId);
      if (!message) return;
      
      // Remove existing reaction from this user
      message.reactions = message.reactions.filter(
        reaction => reaction.userId.toString() !== userId
      );
      
      // Add new reaction if emoji is provided
      if (emoji) {
        message.reactions.push({ userId, emoji });
      }
      
      await message.save();
      
      // Notify both users about the reaction
      socket.emit('messageReactionUpdate', {
        messageId,
        reactions: message.reactions
      });
      
      socket.to(message.senderId.toString()).emit('messageReactionUpdate', {
        messageId,
        reactions: message.reactions
      });
      
      if (message.senderId.toString() !== message.receiverId.toString()) {
        socket.to(message.receiverId.toString()).emit('messageReactionUpdate', {
          messageId,
          reactions: message.reactions
        });
      }
    } catch (error) {
      console.error('Message reaction error:', error);
    }
  });
  
  // Handle typing indicators
  socket.on('typing', (data) => {
    const { userId, receiverId, isTyping } = data;
    socket.to(receiverId).emit('typing', { userId, isTyping });
  });
  
  // Handle disconnect
  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    
    // Find which user was using this socket
    const rooms = Array.from(socket.rooms);
    const userRoom = rooms.find(room => room !== socket.id);
    
    if (userRoom) {
      // Update user offline status
      await User.findByIdAndUpdate(userRoom, { 
        isOnline: false, 
        lastSeen: new Date() 
      });
      
      // Notify contacts that user is offline
      const user = await User.findById(userRoom).populate('contacts');
      user.contacts.forEach(contact => {
        socket.to(contact._id.toString()).emit('userOffline', { userId: userRoom });
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app; // For testing
