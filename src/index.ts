// Main entry point for the RAWG Agent Worker
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { runAgent, runAgentStreaming } from './agent/orchestrator';

// Define the environment bindings type
interface Env {
  RAWG_API_KEY: string;
  GEMINI_API_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for all routes
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

// Favicon handler - return empty response to prevent 404
app.get('/favicon.ico', (c) => {
  return new Response(null, { status: 204 });
});

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main chat endpoint
app.post('/api/chat', async (c) => {
  try {
    const body = await c.req.json();
    const { message, geminiApiKey, rawgApiKey } = body;
    
    if (!message || typeof message !== 'string') {
      return c.json({ error: 'Message is required' }, 400);
    }
    
    // Use user-provided keys if available, otherwise fall back to environment keys
    const geminiKey = geminiApiKey || c.env.GEMINI_API_KEY;
    const rawgKey = rawgApiKey || c.env.RAWG_API_KEY;
    
    if (!geminiKey || !rawgKey) {
      return c.json({ error: 'API keys not configured. Please provide your own API keys in Settings.' }, 500);
    }
    
    // Run the agent
    const response = await runAgent(message, geminiKey, rawgKey);
    
    return c.json(response);
    
  } catch (error: any) {
    console.error('Chat error:', error);
    return c.json({ 
      error: 'An error occurred processing your request',
      details: error.message 
    }, 500);
  }
});

// Streaming chat endpoint with Server-Sent Events
app.post('/api/chat/stream', async (c) => {
  return streamSSE(c, async (stream) => {
    try {
      const body = await c.req.json();
      const { message, geminiApiKey, rawgApiKey } = body;
      
      if (!message || typeof message !== 'string') {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'Message is required' })
        });
        return;
      }
      
      // Use user-provided keys if available, otherwise fall back to environment keys
      const geminiKey = geminiApiKey || c.env.GEMINI_API_KEY;
      const rawgKey = rawgApiKey || c.env.RAWG_API_KEY;
      
      if (!geminiKey || !rawgKey) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'API keys not configured. Please provide your own API keys in Settings.' })
        });
        return;
      }
      
      // Run the agent with streaming
      await runAgentStreaming(message, geminiKey, rawgKey, async (event) => {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event.data)
        });
      });
      
      // Signal completion
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ complete: true })
      });
      
    } catch (error: any) {
      console.error('Streaming error:', error);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ 
          error: 'An error occurred processing your request',
          details: error.message 
        })
      });
    }
  });
});

export default app;
