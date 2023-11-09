const path = require('path');
const { Elysia } = require('elysia');
const API = require('./api.js');
const { Common } = require('./common.js');

class WebServer {
 async run() {
  try {
   this.api = new API();
   await this.api.runAPI();
   await this.startServer();
  } catch (ex) {
   Common.addLog('Cannot start web server.', 2);
   Common.addLog(ex, 2);
  }
 }

 // TODO - add HTTPS support
 async startServer() {
  const app = new Elysia()
   .onRequest((req) => {
    let url = '/' + req.request.url.split('/').slice(3).join('/');
    Common.addLog(req.request.method + ' request from: ' + req.request.headers.get('cf-connecting-ip') + ' (' + (req.request.headers.get('cf-ipcountry') + ')') + ', URL: ' + url);
    //Common.addLog(req.request.method + ' request from: ' + req.headers['cf-connecting-ip'] + ' (' + (req.headers['cf-ipcountry'] + ')') + ', URL path: ' + req.path);
   })
   .post('/api/:name', async (req) => this.getAPI(req))
   .get('/download/:hash/:name', async (req) => this.getDownload(req))
   .get('/upload/:hash/:name', async (req) => this.getUpload(req))
   .get('/admin/', async (req) => this.getAdmin(req))
   .get('/*', async (req) => this.getFile(req));
  const server = { fetch: app.fetch };
  if (Common.settings.web.standalone) server.port = Common.settings.web.port;
  else server.unix = Common.settings.web.socket_path;
  Bun.serve(server);
  Common.addLog('Web server is running on ' + (Common.settings.web.standalone ? 'port: ' + Common.settings.web.port : 'Unix socket: ' + Common.settings.web.socket_path));
 }

 async getAPI(req) {
  return new Response(JSON.stringify(await this.api.processAPI(req.params.name, req.body)), { headers: { 'Content-Type': 'application/json' }})
 }

 async getUpload(req) {
  if (!req.params.hash || !req.params.name) return this.getIndex(req);
  const file = Bun.file(path.join(Common.settings.storage.upload, req.params.hash));
  if (!await file.exists()) return this.getIndex(req);
  return new Response(file, {
   headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="' + req.params.name + '"'
   }
  });
 }

 async getDownload(req) {
  if (!req.params.hash || !req.params.name) return this.getIndex(req);
  const file = Bun.file(path.join(Common.settings.storage.download, req.params.hash));
  if (!await file.exists()) return this.getIndex(req);
  return new Response(file, {
   headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="' + req.params.name + '"'
   }
  });
 }

 async getAdmin(req) {
  const content = await Bun.file(path.join(__dirname, '../web/static/admin/index.html')).text();
  return new Response(Common.translate(content, {
   '{TITLE}': Common.settings.web.name + ' - Admin area'
  }), { headers: { 'Content-Type': 'text/html' }});
 }

 async getIndex(req) {
  const content = await Bun.file(path.join(__dirname, '../web/static/user/index.html')).text();
  return new Response(Common.translate(content, {
   '{TITLE}': Common.settings.web.name,
   // TODO: BUG: returns "http://server/..." in request.host and req.request.url, not an actual host that comes from the user
   '{OG-URL}': req.request.url,
   '{OG-DESCRIPTION}': Common.settings.web.description,
   '{OG-IMAGE}': '/img/logo-og.webp'
  }), { headers: { 'Content-Type': 'text/html' }});
 }

 async getFile(req) {
  const file = Bun.file(path.join(__dirname, '../web/static/user/', req.path));
  if (!await file.exists()) return this.getIndex(req);
  else return new Response(file);
 };
}

module.exports = WebServer;

/* OLD - Express.js:
 async startServer() {
  const app = express();
  app.use((req, res, next) => {
   Common.addLog('Request from: ' + (req.ip || req.headers['x-forwarded-for'] || 'Unknown') + ', URL path: ' + req.url);
   next();
  });
  app.use(express.json());
  app.use('/api/:name', async (req, res) => res.type('json').send(JSON.stringify(await this.api.processAPI(req.params.name, req.body))));
  app.use('/img/categories/', express.static(path.join(Common.settings.storage.images + 'categories')));
  app.use('/img/items/', express.static(path.join(Common.settings.storage.images, 'items')));
  app.use('/download/:hash/:name', (req, res) => {
   // TODO - PREVENT FROM PATH INJECTION !!!!!!!!!!!!!!!! (../../root/...):
   // TODO - BUG: crashes with big files (1.2 GB+) in Bun (in Node.js OK) - switch to Elysia?
   res.setHeader('Content-Disposition', 'attachment; filename=' + req.params.name);
   res.sendFile(path.join(Common.settings.storage.download, req.params.hash));
  });
  app.use('/upload/:hash/:name', (req, res) => {
   // TODO - PREVENT FROM PATH INJECTION !!!!!!!!!!!!!!!! (../../root/...):
   // TODO - BUG: crashes with big files (1.2 GB+) in Bun (in Node.js OK) - switch to Elysia?
   res.setHeader('Content-Disposition', 'attachment; filename=' + req.params.name);
   res.sendFile(path.join(Common.settings.storage.upload, req.params.hash));
  });
  app.use('/admin/', express.static(path.join(__dirname, '../web/admin/')));
  app.use('/admin/', (req, res) => {
   res.send(Common.translate(fs.readFileSync(path.join(__dirname, '../web/admin/index.html'), 'utf8'), {
    '{TITLE}': Common.settings.web.name + ' - Admin area'
   }));
  });
  app.use('/', express.static(path.join(__dirname, '../web/user')));
  app.use('/', (req, res) => {
   res.send(Common.translate(fs.readFileSync(path.join(__dirname, '../web/user/index.html'), 'utf8'), {
    '{TITLE}': Common.settings.web.name,
    '{OG-URL}': req.url,
    '{OG-DESCRIPTION}': Common.settings.web.description,
    '{OG-IMAGE}': '/img/logo-og.webp'
   }));
  });
  if (!Common.settings.web.standalone) fs.unlinkSync(Common.settings.web.socket_path);
  app.listen(Common.settings.web.standalone ? Common.settings.web.port : Common.settings.web.socket_path, () => {
   if (!Common.settings.web.standalone) fs.chmodSync(Common.settings.web.socket_path, '777');
   Common.addLog('Web server is running on ' + (Common.settings.web.standalone ? 'port: ' + Common.settings.web.port : 'Unix socket: ' + Common.settings.web.socket_path));
  });
 }
*/

/* OLD 2: Bun.serve (without middleware) - DELETE WHEN NOT NEEDED ANYMORE:
const multipart = require('parse-multipart-data');

startServer() {
 const serverConfig = (Common.settings.web && Common.settings.web.standalone) ? { host: '0.0.0.0', port: Common.settings.web.port || 8000 } : { unix: Common.settings.web.socket_path };
 Bun.serve({ ...serverConfig, fetch: this.handleRequest.bind(this) });
 if (serverConfig.port) Common.addLog(`Web server is running on port: ${serverConfig.port} ...`);
 else Common.addLog(`Web server is running on unix socket: ${serverConfig.unix} ...`);
}

async handleRequest(req) {
 const body = await this.parseRequestBody(req);
 const ppath = new URL(req.url).pathname;
 if (ppath.startsWith('/api/')) {
  const response = await this.api.processAPI(ppath.substring(5), body);
  return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
 }
 return this.handleStaticFiles(req, ppath);
}

async parseRequestBody(req) {
 const contentType = req.headers.get('content-type');
 const contentLength = parseInt(req.headers.get('content-length'), 10);
 if (contentType && contentType.includes('application/json') && contentLength > 0) return await req.json();
 else if (contentType && contentType.startsWith('multipart/form-data')) return this.parseMultipartData(req, contentType);
 else if (contentType && contentType.includes('application/x-www-form-urlencoded')) {
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
 if (!safePath.startsWith(webRoot)) return new Response('Access denied', { status: 403 });
 const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff'];
 if (fs.existsSync(safePath)) {
  if (safePath.endsWith('index.html')) {
   const fullUrl = `http://${req.headers.get('host')}`;
   const fileContent = fs.readFileSync(safePath, 'utf8');
   const replacedContent = Common.replacePlaceholders(fileContent, fullUrl);
   return new Response(replacedContent, { headers: { 'Content-Type': 'text/html' } });
  }
  return new Response(Bun.file(safePath));
 } else if (imageExtensions.some((ext) => safePath.endsWith(ext))) return new Response(Bun.file(path.join(webRoot, 'img/item-default.webp')));
 const fileContent = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
 const replacedContent = Common.replacePlaceholders(fileContent, `http://${req.headers.get('host')}`);
 return new Response(replacedContent, { headers: { 'Content-Type': 'text/html' } });
}
*/
