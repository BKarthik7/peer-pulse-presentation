import express from 'express';
import cors from 'cors';
import Pusher from 'pusher';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { register, Counter, Histogram } from 'prom-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize metrics
const httpRequestCounter = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status']
});

const requestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.1, 0.3, 0.5, 1, 3, 5, 10]
});

// Add middleware to count requests
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    httpRequestCounter.inc({
      method: req.method,
      path: req.path,
      status: res.statusCode.toString()
    });
    requestDuration.observe({
      method: req.method,
      path: req.path,
      status: res.statusCode.toString()
    }, duration / 1000);
  });
  
  next();
});

// Metrics endpoint
app.get('/api/metrics', async (req, res) => {
  try {
    const metrics = await register.metrics();
    res.setHeader('Content-Type', register.contentType);
    res.end(metrics);
  } catch (error) {
    console.error('Error collecting metrics:', error);
    res.status(500).end('Error collecting metrics');
  }
});

// Initialize Pusher
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

// MongoDB Schema
const evaluationSchema = new mongoose.Schema({
  teamName: String,
  evaluatorUSN: String,
  ratings: Object,
  feedback: String,
  submittedAt: Date
});

const Evaluation = mongoose.models.Evaluation || mongoose.model('Evaluation', evaluationSchema);

// MongoDB connection
const connectDB = async () => {
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('MongoDB connected successfully');
    }
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
};

// API Routes
app.post('/api/upload', async (req, res) => {
  try {
    await connectDB();
    const { event, data, type } = req.body;

    // Handle CSV upload
    if (type === 'participants' || type === 'teams') {
      // For now, just acknowledge the upload
      return res.status(200).json({ 
        message: `Successfully processed ${type} upload`,
        count: data.length 
      });
    }

    // Handle different events
    switch (event) {
      case 'presentationStarting':
      case 'presentationStarted':
      case 'presentationEnded':
      case 'timeSync':
      case 'evaluationForm':
      case 'presentationReset':
        await pusher.trigger('presentation', event, data);
        break;

      case 'evaluationSubmitted':
        // Store evaluation in database
        const evaluation = await Evaluation.create({
          teamName: data.team,
          evaluatorUSN: data.evaluator,
          ratings: data.evaluation.ratings,
          feedback: data.evaluation.feedback,
          submittedAt: new Date()
        });

        // Emit the stored evaluation to all clients
        await pusher.trigger('presentation', 'evaluationSubmitted', {
          ...data,
          evaluationId: evaluation._id
        });

        // Fetch all evaluations for the team and emit to admin
        const teamEvaluations = await Evaluation.find({ teamName: data.team });
        await pusher.trigger('presentation', 'teamEvaluations', {
          team: data.team,
          evaluations: teamEvaluations
        });
        break;

      default:
        return res.status(400).json({ message: 'Invalid event type' });
    }

    res.status(200).json({ message: 'Event processed successfully' });
  } catch (error) {
    console.error('Error processing event:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/test', (req, res) => {
  res.status(200).json({ message: 'Hello World' });
});

app.get('/api/', (req, res) => {
  res.status(200).json({ message: 'Hello World' });
});

// Pusher authentication endpoint
app.post('/api/pusher-auth', (req, res) => {
  const { socket_id, channel_name } = req.body;
  const authResponse = pusher.authorizeChannel(socket_id, channel_name);
  res.status(200).json(authResponse);
});

// Basic health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve static files
app.use(express.static(path.join(__dirname, 'dist')));

// New endpoint to get all feedbacks grouped by team name
app.get('/feedbacks', async (req, res) => {
  try {
    await connectDB();
    const evaluations = await Evaluation.find({});
    
    // Group evaluations by team name
    const groupedFeedbacks = evaluations.reduce((acc, evaluation) => {
      if (!acc[evaluation.teamName]) {
        acc[evaluation.teamName] = [];
      }
      acc[evaluation.teamName].push({
        evaluatorUSN: evaluation.evaluatorUSN,
        ratings: evaluation.ratings,
        feedback: evaluation.feedback,
        submittedAt: evaluation.submittedAt
      });
      return acc;
    }, {});
    res.status(200).json(groupedFeedbacks);
  } catch (error) {
    console.error('Error fetching feedbacks:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Handle all other routes by serving index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Export the Express app for Vercel
export default app;