/**
 * ByIbosCode Local Proxy
 * Translates Anthropic API format to OpenAI format -> Forwards to LM Studio
 * Port: 8082
 */

const http = require('http');

const LM_STUDIO_URL = 'http://localhost:1234/v1/chat/completions';
const PROXY_PORT = 8082;

function convertMessages(anthropicMessages) {
  return anthropicMessages.map(msg => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }
    if (Array.isArray(msg.content)) {
      const textParts = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_result') {
          const resultText = Array.isArray(block.content)
            ? block.content.map(c => c.text || '').join('\n')
            : String(block.content || '');
          textParts.push(`[Tool Result: ${resultText}]`);
        } else if (block.type === 'tool_use') {
          textParts.push(`[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`);
        }
      }
      return {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: textParts.join('\n') || ' ',
      };
    }
    return { role: msg.role, content: String(msg.content) };
  });
}

function convertTools(anthropicTools) {
  if (!anthropicTools || anthropicTools.length === 0) return undefined;
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

// Convert synchronous (non-streaming) OpenAI responses back to Anthropic format
function convertResponse(openaiResponse, requestId) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) {
    return {
      id: requestId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'No response from model.' }],
      model: openaiResponse.model || 'local',
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const message = choice.message;
  const content = [];

  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(toolCall.function.arguments || '{}'); } catch { input = { raw: toolCall.function.arguments }; }
      content.push({
        type: 'tool_use',
        id: toolCall.id || `tool_${Date.now()}`,
        name: toolCall.function.name,
        input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';

  return {
    id: requestId || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: openaiResponse.model || 'local',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method !== 'POST' || !req.url.includes('/v1/messages')) {
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
  }

  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', async () => {
    try {
      const anthropicRequest = JSON.parse(body);
      const isStream = !!anthropicRequest.stream;

      console.log(`\n→ [${new Date().toLocaleTimeString()}] Incoming Request`);
      console.log(`  Model: ${anthropicRequest.model}`);
      console.log(`  Message Count: ${anthropicRequest.messages?.length}`);
      console.log(`  Stream Format: ${isStream ? 'ACTIVE (Real-Time)' : 'DISABLED'}`);

      const systemContent = Array.isArray(anthropicRequest.system)
        ? anthropicRequest.system.map(s => s.text || s).join('\n')
        : anthropicRequest.system || '';

      const openaiMessages = [];
      if (systemContent) openaiMessages.push({ role: 'system', content: systemContent });
      if (anthropicRequest.messages) openaiMessages.push(...convertMessages(anthropicRequest.messages));

      const openaiPayload = {
        model: 'local-model',
        messages: openaiMessages,
        max_tokens: anthropicRequest.max_tokens || 4096,
        temperature: anthropicRequest.temperature ?? 0.7,
        stream: isStream, // Request stream from LM Studio!
      };

      const tools = convertTools(anthropicRequest.tools);
      if (tools) { openaiPayload.tools = tools; openaiPayload.tool_choice = 'auto'; }

      const payloadStr = JSON.stringify(openaiPayload);
      const url = new URL(LM_STUDIO_URL);

      const options = {
        hostname: url.hostname,
        port: url.port || 1234,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr),
        },
      };

      const proxyReq = http.request(options, proxyRes => {
        if (proxyRes.statusCode !== 200) {
          console.error(`  ✗ LM Studio HTTP Error: ${proxyRes.statusCode}`);
          res.writeHead(500); res.end(JSON.stringify({ error: { type: 'api_error', message: 'LM Studio error' } }));
          return;
        }

        if (isStream) {
          // True SSE Real-Time Streaming Mode
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const requestId = `msg_${Date.now()}`;
          res.write(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: { id: requestId, type: 'message', role: 'assistant', model: 'local-model', usage: {input_tokens:0, output_tokens:0} }
          })}\n\n`);

          let blockStarted = false;

          proxyRes.on('data', chunk => {
            const lines = chunk.toString().split('\n');
            for(let line of lines) {
              line = line.trim();
              if(line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const parsed = JSON.parse(line.substring(6));
                  const textDelta = parsed.choices?.[0]?.delta?.content;
                  if (textDelta) {
                    if (!blockStarted) {
                      res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }
                      })}\n\n`);
                      blockStarted = true;
                    }
                    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: textDelta }
                    })}\n\n`);
                    process.stdout.write(textDelta); // Output character by character to proxy console
                  }
                } catch(e) {}
              }
            }
          });

          proxyRes.on('end', () => {
            console.log(`\n  ✓ Stream fully broadcasted.`);
            if(blockStarted) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({type: 'content_block_stop', index: 0})}\n\n`);
            }
            res.write(`event: message_delta\ndata: ${JSON.stringify({type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 }})}\n\n`);
            res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
            res.end();
          });

        } else {
          // No Streaming (Single block response)
          let data = '';
          proxyRes.on('data', chunk => (data += chunk));
          proxyRes.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const anthropicResponse = convertResponse(parsed, `msg_${Date.now()}`);
              console.log(`  ✓ Response received in one block (${anthropicResponse.usage.output_tokens || 0} tokens)`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(anthropicResponse));
            } catch(e) {
              res.writeHead(500); res.end(JSON.stringify({ error: { type: 'api_error', message: 'Parse error' } }));
            }
          });
        }
      });

      proxyReq.on('error', err => {
        console.error('  ✗ LM Studio API Connection Error:', err.message);
        res.writeHead(500); res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
      });
      proxyReq.write(payloadStr);
      proxyReq.end();

    } catch (err) {
      console.error('  ✗ Internal Proxy Error:', err.message);
      res.writeHead(500); res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
    }
  });
});

server.listen(PROXY_PORT, () => {
  console.log('╔═════════════════════════════════════════════════════╗');
  console.log('║      ByIbosCode Local Proxy v2.0 (True-Stream)      ║');
  console.log('╠═════════════════════════════════════════════════════╣');
  console.log(`║  Proxy Listening -> http://localhost:${PROXY_PORT}          ║`);
  console.log(`║  LM Studio Target -> ${LM_STUDIO_URL} ║`);
  console.log('╚═════════════════════════════════════════════════════╝\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PROXY_PORT} is in use! Another proxy is already running.`);
  else console.error('Server error:', err);
});
