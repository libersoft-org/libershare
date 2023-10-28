const API = require('./api.js');
const { Common } = require('./common.js');
const fs = require('fs');
const multipart = require('parse-multipart-data');
const path = require('path');

class WebServer {
 async run() {
  try {
   this.api = new API();
   await this.api.runAPI();
   this.setupServer();
  } catch (ex) {
   Common.addLog('Cannot start web server.', 2);
   Common.addLog(ex, 2);
  }
 }

 setupServer() {
  const webRoot = path.join(Common.appPath, 'web');
  const serverConfig = this.getServerConfig();
  const server = Bun.serve({
   ...serverConfig,
   fetch: this.handleRequest.bind(this)
  });

  if (serverConfig.port) {
   Common.addLog(`Web server is running on port: ${serverConfig.port} ...`);
  } else {
   Common.addLog(`Web server is running on unix socket: ${serverConfig.unix} ...`);
  }
 }

 getServerConfig() {
  if (Common.settings.web && Common.settings.web.standalone) {
   return {
    host: '0.0.0.0',
    port: Common.settings.web.port || 8000
   };
  }
  return {
   unix: Common.settings.web.socket_path
  };
 }

 async handleRequest(req) {
  const body = await this.parseRequestBody(req);
  const ppath = new URL(req.url).pathname;

  if (ppath.startsWith('/api/')) {
   const response = await this.api.processAPI(ppath.substring(5), body);
   return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' }
   });
  }

  return this.handleStaticFiles(req, ppath);
 }

 async parseRequestBody(req) {
  const contentType = req.headers.get('content-type');
  const contentLength = parseInt(req.headers.get('content-length'), 10);

  if (contentType && contentType.includes('application/json') && contentLength > 0) {
   return await req.json();
  } else if (contentType && contentType.startsWith('multipart/form-data')) {
   return this.parseMultipartData(req, contentType);
  } else if (contentType && contentType.includes('application/x-www-form-urlencoded')) {
   const formData = await req.formData();
   return Object.fromEntries(formData.entries());
  }
  return {};
 }

 async parseMultipartData(req, contentType) {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const boundary = contentType.split(';')[1].split('=')[1];
  const parts = multipart.parse(rawBody, boundary);
  return parts.reduce((acc, part) => {
   acc[part.name] = part.filename || part.data.toString();
   return acc;
  }, {});
 }

 handleStaticFiles(req, ppath) {
  const webRoot = path.join(Common.appPath, 'web');
  const safePath = path.normalize(path.join(webRoot, ppath === '/' ? 'index.html' : ppath)).replace(/^(\.\.[\/\\])+/, '');

  if (!safePath.startsWith(webRoot)) {
   return new Response('Access denied', { status: 403 });
  }

  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff'];

  if (fs.existsSync(safePath)) {
   if (safePath.endsWith('index.html')) {
    const fullUrl = `http://${req.headers.get('host')}`;
    const fileContent = fs.readFileSync(safePath, 'utf8');
    const replacedContent = Common.replacePlaceholders(fileContent, fullUrl);
    return new Response(replacedContent, { headers: { 'Content-Type': 'text/html' } });
   }
   return new Response(Bun.file(safePath));
  } else if (imageExtensions.some((ext) => safePath.endsWith(ext))) {
   return new Response(Bun.file(path.join(webRoot, 'img/item-default.webp')));
  }

  const fileContent = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
  const replacedContent = Common.replacePlaceholders(fileContent, `http://${req.headers.get('host')}`);
  return new Response(replacedContent, { headers: { 'Content-Type': 'text/html' } });
 }

 stop() {
  // Stopping the Bun server might be different from Express.js.
  // You might need to refer to Bun's documentation for the exact method.
  // For now, I'm leaving this method empty.
 }
}

module.exports = WebServer;
