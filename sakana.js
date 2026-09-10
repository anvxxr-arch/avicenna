const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
];

const BASE = 'https://chat.sakana.ai';
const FIREBASE_KEY = 'AIzaSyBIJuyUokxGiETY0Nu3hQNC1dMadHyf_I4';
const MODELS = ['namazu', 'sakana', 'namazu-v2', 'namazu-pro', 'llama'];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function request(method, url, options = {}, retries = 3) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const headers = {
        'User-Agent': randomUA(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        ...(options.headers || {})
      };
      const config = {
        method,
        url,
        headers,
        timeout: 30000,
        maxRedirects: 5,
        ...options
      };
      if (options.data && options.data.pipe) {
        config.data = options.data;
      }
      const response = await axios(config);
      return response;
    } catch (error) {
      lastError = error;
      if (error.response && error.response.status === 403) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

class SakanaAI {
  constructor() {
    this.cookie = null;
  }

  async _getCookie() {
    if (this.cookie) return this.cookie;
    const signup = await request('POST', `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_KEY}`, {
      data: { returnSecureToken: true, tenantId: 'sakana-talk-prd-pvl72' }
    });
    const login = await request('POST', `${BASE}/api/auth/login`, {
      data: new URLSearchParams({ idToken: signup.data.idToken }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Referer: BASE }
    });
    const cookieHeader = login.headers['set-cookie'] || [];
    this.cookie = cookieHeader.find(c => c.startsWith('sakana-chat='))?.split(';')[0];
    if (!this.cookie) throw new Error('Failed to get session cookie');
    return this.cookie;
  }

  async getModels() {
    const cookie = await this._getCookie();
    const res = await request('GET', `${BASE}/api/agents`, { headers: { Cookie: cookie } });
    return res.data.map(a => a.id);
  }

  async getConversations(limit = 20) {
    const cookie = await this._getCookie();
    try {
      const res = await request('GET', `${BASE}/api/conversations?limit=${limit}`, { headers: { Cookie: cookie } });
      return res.data;
    } catch {
      return [];
    }
  }

  async deleteConversation(id) {
    const cookie = await this._getCookie();
    try {
      const res = await request('DELETE', `${BASE}/conversation/${id}`, { headers: { Cookie: cookie } });
      return res.data;
    } catch {
      return null;
    }
  }

  cleanText(text) {
    return text
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/^-\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/#{1,6}\s*/g, '')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async chat(question, options = {}) {
    const {
      model = 'namazu',
      conversationId = null,
      parentMessageId = null,
      needSearch = 0,
      thinking = 0,
      toneMode = 'default',
      streamOutput = false
    } = options;

    if (!question) throw new Error('Question is required.');
    if (thinking && needSearch) throw new Error('Thinking and Web Search cannot be used together.');
    if (!MODELS.includes(model)) throw new Error(`Model not found. Available: ${MODELS.join(', ')}`);

    const cookie = await this._getCookie();
    let convId = conversationId;
    let parentId = parentMessageId;

    if (!convId) {
      const create = await request('POST', `${BASE}/conversation`, {
        data: {
          inputs: question,
          enableThinking: thinking === 1,
          toneMode,
          webSearchEnabled: needSearch === 1,
          agentId: model
        },
        headers: { Cookie: cookie, Origin: BASE, Referer: BASE }
      });
      convId = create.data.conversationId;
      parentId = create.data.systemMessageId;
    }

    const fd = new FormData();
    fd.append('data', JSON.stringify({
      inputs: question,
      id: parentId,
      is_retry: false,
      is_continue: false,
      enableThinking: thinking === 1,
      toneMode,
      webSearchEnabled: needSearch === 1,
      userMessageId: crypto.randomUUID()
    }));

    const res = await request('POST', `${BASE}/conversation/${convId}`, {
      data: fd,
      headers: {
        Cookie: cookie,
        Origin: BASE,
        Referer: BASE,
        'x-requested-with': 'com.xbrowser.play',
        ...fd.getHeaders()
      },
      responseType: 'stream'
    });

    return new Promise((resolve, reject) => {
      let fullText = '';
      let messageId = null;
      let buf = '';
      let processedIndex = 0;

      res.data.on('data', chunk => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'createdMessage') messageId = parsed.messageId;
            if (parsed.type === 'stream' && parsed.token) {
              fullText += parsed.token.replace(/\0/g, '');
              if (streamOutput) {
                while (processedIndex < fullText.length) {
                  const rem = fullText.substring(processedIndex);
                  if (rem.startsWith('<plan>') || rem.startsWith('<think>')) {
                    process.stdout.write('\n\x1b[90m[Thinking]: ');
                    processedIndex += rem.startsWith('<plan>') ? 6 : 7;
                    continue;
                  }
                  if (rem.startsWith('</plan>') || rem.startsWith('</think>')) {
                    process.stdout.write('\x1b[0m\n');
                    processedIndex += rem.startsWith('</plan>') ? 7 : 8;
                    continue;
                  }
                  if (rem.startsWith('<answer>') || rem.startsWith('</answer>')) {
                    processedIndex += rem.startsWith('<answer>') ? 8 : 9;
                    continue;
                  }
                  if (rem.startsWith('<source-chip')) {
                    const close = rem.indexOf('/>');
                    if (close !== -1) {
                      processedIndex += close + 2;
                      continue;
                    } else break;
                  }
                  if (rem.startsWith('<') && !rem.includes('>')) break;
                  process.stdout.write(rem[0]);
                  processedIndex++;
                }
              }
            }
          } catch {}
        }
      });

      res.data.on('end', () => {
        const cleaned = this.cleanText(
          fullText
            .replace(/<plan>[\s\S]*?<\/plan>/g, '')
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .replace(/<source-chip[^>]*\/>/g, '')
            .replace(/<\/?[a-zA-Z0-9_-]+[^>]*>/g, '')
        );
        resolve({
          text: cleaned,
          conversationId: convId,
          parentMessageId: messageId
        });
      });

      res.data.on('error', reject);
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(JSON.stringify({
      creator: 'rynaqrtz',
      info: { command: 'help', status: 'ok' },
      data: { usage: 'node sakana.js <question> [--model <model>] [--search] [--thinking] [--stream]' }
    }, null, 2));
    return;
  }

  const sakana = new SakanaAI();
  const output = { creator: 'rynaqrtz', info: {}, data: {} };

  try {
    if (args[0] === 'models') {
      const models = await sakana.getModels();
      output.info = { command: 'models', status: 'ok' };
      output.data = { models };
    } else if (args[0] === 'conversations') {
      const convs = await sakana.getConversations(20);
      output.info = { command: 'conversations', status: 'ok' };
      output.data = { conversations: convs };
    } else if (args[0] === 'delete') {
      if (!args[1]) throw new Error('Missing conversation ID');
      const result = await sakana.deleteConversation(args[1]);
      output.info = { command: 'delete', status: 'ok' };
      output.data = { deleted: result };
    } else {
      let question = args[0];
      let model = 'namazu';
      let search = false;
      let thinking = false;
      let streamOutput = false;

      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--model' && args[i + 1]) {
          model = args[i + 1];
          i++;
        } else if (args[i] === '--search') {
          search = true;
        } else if (args[i] === '--thinking') {
          thinking = true;
        } else if (args[i] === '--stream') {
          streamOutput = true;
        } else if (args[i] === '--help') {
          console.log(JSON.stringify({
            creator: 'rynaqrtz',
            info: { command: 'help', status: 'ok' },
            data: { usage: 'node sakana.js <question> [--model <model>] [--search] [--thinking] [--stream]' }
          }, null, 2));
          return;
        }
      }

      const result = await sakana.chat(question, {
        model,
        needSearch: search ? 1 : 0,
        thinking: thinking ? 1 : 0,
        streamOutput
      });

      output.info = { model, search, thinking, status: 'ok' };
      output.data = {
        text: result.text,
        conversationId: result.conversationId,
        parentMessageId: result.parentMessageId
      };

      if (streamOutput) console.log('\n');
    }
  } catch (error) {
    output.info = { status: 'error', message: error.message };
  }

  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) main();
module.exports = { SakanaAI };