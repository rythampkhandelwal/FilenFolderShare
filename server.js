const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const mime = require('mime-types');

const app = express();
// Basic configuration
const PORT = 6469;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

fs.ensureDirSync(UPLOADS_DIR);
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuration via env
const AUTO_COMPACT_ON_START = process.env.AUTO_COMPACT_ON_START !== 'false';

// Compact existing directories (zip then delete) to save space
async function compactDirectory(dirName) {
  const folderPath = path.join(UPLOADS_DIR, dirName);
  const zipPath = path.join(UPLOADS_DIR, `${dirName}.zip`);
  const stat = await fs.stat(folderPath).catch(() => null);
  if (!stat || !stat.isDirectory()) return { skipped: dirName, reason: 'not-directory' };
  if (await fs.pathExists(zipPath)) {
    // if zip exists assume folder can be removed
    try { await fs.remove(folderPath); return { removed: dirName, zipExisted: true }; } catch (e) { return { error: dirName, message: e.message }; }
  }
  // create zip
  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(folderPath, false);
      archive.finalize();
    });
    await fs.remove(folderPath);
    return { compacted: dirName };
  } catch (e) {
    return { error: dirName, message: e.message };
  }
}

async function compactAll() {
  const entries = await fs.readdir(UPLOADS_DIR, { withFileTypes: true });
  const results = [];
  for (const ent of entries) {
    if (ent.isDirectory()) {
      // ignore hidden system directories as a precaution
      if (ent.name.startsWith('.')) continue;
      // Avoid racing with active upload: skip if a lock file exists
      const lockPath = path.join(UPLOADS_DIR, `${ent.name}.uploading`);
      if (await fs.pathExists(lockPath)) continue;
      /* eslint-disable no-await-in-loop */
      results.push(await compactDirectory(ent.name));
    }
  }
  return results;
}

// Helper: sanitize and ensure a path stays within base dir
function safeJoin(base, target) {
  const normalized = path.normalize(target).replace(/^([/\\])+/, ''); // remove leading slashes
  const full = path.join(base, normalized);
  if (!full.startsWith(base)) {
    throw new Error('Invalid path');
  }
  return full;
}

// Helper: compute root folder name from relative paths
function getRootName(paths) {
  if (!paths || paths.length === 0) return null;
  const parts = paths[0].split('/');
  return parts.length > 1 ? parts[0] : null;
}

// Multer memory storage (preserves folder structure manually)
const upload = multer({ storage: multer.memoryStorage() });

// Upload endpoint
app.post('/upload', upload.any(), async (req, res) => {
  try {
    // req.body.paths can be string or array matching files order
    let paths = req.body.paths || [];
    if (!Array.isArray(paths)) paths = [paths];

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).send('No files uploaded.');
    }

    // Derive a root folder name if uploading a folder
    // If any path contains '/', treat as folder upload
    const hasNested = paths.some(p => typeof p === 'string' && p.includes('/'));
    const rootFromPaths = getRootName(paths.filter(Boolean));

    // If no nested paths, save files individually in uploads root
    if (!hasNested && !rootFromPaths) {
      for (const f of files) {
        const name = path.basename(f.originalname);
        const destPath = safeJoin(UPLOADS_DIR, name);
        await fs.outputFile(destPath, f.buffer);
      }
      const names = files.map(f => path.basename(f.originalname));
      const first = names[0];
      return res.send(
        `<div class="success">Uploaded ${names.length} file${names.length>1?'s':''}.</div>` +
        `<div class="actions">` +
        (names.length === 1
          ? `<a href="/download/file/${encodeURIComponent(first)}" class="btn">Download ${first}</a>`
          : `<a href="/list" class="btn">View uploads</a>`
        ) +
        ` <a href="/" class="link">Back</a></div>`
      );
    }

    // Otherwise, it's a folder upload (preserve structure and zip)
    const baseName = rootFromPaths || `upload_${Date.now()}`;
    const baseDir = path.join(UPLOADS_DIR, baseName);
    await fs.ensureDir(baseDir);

    // Write each file respecting its relative path (strip the common root if present)
  for (let i = 0; i < files.length; i++) {
      const f = files[i];
      // Prefer the paired path if present; fallback to originalname
      let rel = paths[i] || f.originalname;
      if (rootFromPaths && rel.startsWith(rootFromPaths + '/')) {
        rel = rel.substring(rootFromPaths.length + 1);
      }
      const targetPath = safeJoin(baseDir, rel);
  await fs.outputFile(targetPath, f.buffer);
    }

    // Create a zip alongside the folder
    const zipPath = path.join(UPLOADS_DIR, `${baseName}.zip`);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(baseDir, false);
      archive.finalize();
    });

    // Space optimization: remove original extracted folder after successful zip
  try { await fs.remove(baseDir); } catch (cleanupErr) { console.warn('Cleanup (folder removal) failed for', baseDir, cleanupErr.message); }

    return res.send(
      `<div class="success">Uploaded folder ${baseName}</div>` +
      `<div class="actions"><a href="/download/zip/${encodeURIComponent(baseName)}" class="btn">Download ZIP</a> <a href="/list" class="link">View uploads</a></div>`
    );
  } catch (err) {
    console.error(err);
    return res.status(500).send('Upload failed.');
  }
});

// Download single file saved at root of uploads
app.get('/download/file/:filename', (req, res) => {
  try {
    const filePath = safeJoin(UPLOADS_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    res.download(filePath);
  } catch (e) {
    res.status(400).send('Invalid path');
  }
});

// Download single file inside a folder upload (backward compatible)
app.get('/download/file/:folder/:filename', (req, res) => {
  try {
    const base = path.join(UPLOADS_DIR, req.params.folder);
    const filePath = safeJoin(base, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    res.download(filePath);
  } catch (e) {
    res.status(400).send('Invalid path');
  }
});

// Download zip for a folder
app.get('/download/zip/:folder', (req, res) => {
  try {
    const zipPath = path.join(UPLOADS_DIR, `${req.params.folder}.zip`);
    if (fs.existsSync(zipPath)) {
      res.download(zipPath);
    } else {
      res.status(404).send('ZIP not found.');
    }
  } catch (e) {
    res.status(400).send('Invalid path');
  }
});

// Helper: compute total folder size (shallow + nested) with safeguard
async function computeFolderSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    try {
      const items = await fs.readdir(current, { withFileTypes: true });
      for (const it of items) {
        const full = path.join(current, it.name);
        if (it.isDirectory()) stack.push(full); else if (it.isFile()) {
          const st = await fs.stat(full);
          total += st.size;
        }
      }
    } catch (_) { /* ignore */ }
    // Soft limit to avoid extreme traversals (e.g., > 50k files)
    if (total > 1e9) break; // 1 GB early stop
  }
  return total;
}

// API: List uploads (files, folders, and archives). Returns metadata for UI.
app.get('/api/uploads', async (req, res) => {
  try {
    const entries = await fs.readdir(UPLOADS_DIR, { withFileTypes: true });
    let files = [];
    let folders = [];
    const now = Date.now();
    for (const dirent of entries) {
      const name = dirent.name;
      const full = path.join(UPLOADS_DIR, name);
      if (dirent.isDirectory()) {
        const childNames = await fs.readdir(full);
        const zipExists = await fs.pathExists(path.join(UPLOADS_DIR, `${name}.zip`));
        const stat = await fs.stat(full);
        let sizeBytes = 0;
        // compute size lazily only if explicitly requested via query ?details=1
        if (req.query.details === '1') {
          sizeBytes = await computeFolderSize(full);
        }
        folders.push({
          name,
          count: childNames.length,
          zip: zipExists,
            modified: stat.mtimeMs,
            ageSeconds: Math.round((now - stat.mtimeMs) / 1000),
            size: sizeBytes || undefined
        });
      } else if (dirent.isFile()) {
        const stat = await fs.stat(full);
        const ext = path.extname(name).replace('.', '').toLowerCase();
        files.push({
          name,
          size: stat.size,
          ext,
          modified: stat.mtimeMs,
          ageSeconds: Math.round((now - stat.mtimeMs) / 1000)
        });
      }
    }
  res.json({ files, folders });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

// Legacy HTML list
app.get('/list', async (req, res) => {
  const items = await fs.readdir(UPLOADS_DIR, { withFileTypes: true });
  let html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Uploads</title><link rel="stylesheet" href="/style.css"></head><body><div class="container"><h2>Uploaded Items</h2><ul class="list">`;

  for (const ent of items) {
    const name = ent.name;
    if (ent.isDirectory()) {
      const zipExists = await fs.pathExists(path.join(UPLOADS_DIR, `${name}.zip`));
      html += `<li><span class="item folder">${name}</span> — ` + (zipExists ? `<a href="/download/zip/${encodeURIComponent(name)}" class="btn small">Download ZIP</a>` : '<em>(Zipping...)</em>') + ` <button class="link danger" onclick="deleteUpload('${name}', true)">Delete</button></li>`;
    } else if (ent.isFile()) {
      const isZip = name.endsWith('.zip');
      const downloadHref = isZip ? `/download/file/${encodeURIComponent(name)}` : `/download/file/${encodeURIComponent(name)}`;
      html += `<li><span class="item file">${name}</span> — <a href="${downloadHref}" class="btn small">Download</a> <button class="link danger" onclick="deleteUpload('${name}', false)">Delete</button></li>`;
    }
  }

  html += `</ul>
  <p><a href="/" class="link">Upload more</a></p>
  <script>
    async function deleteUpload(name, isFolder) {
      if (!confirm('Delete ' + name + '?')) return;
      const target = isFolder ? '/delete/folder/' + encodeURIComponent(name) : '/delete/file/' + encodeURIComponent(name);
      const res = await fetch(target, { method: 'DELETE' });
      if (res.ok) location.reload(); else alert('Delete failed');
    }
  </script>
  </div></body></html>`;
  res.send(html);
});

// Delete file in uploads root
app.delete('/delete/file/:name', async (req, res) => {
  try {
    const filePath = safeJoin(UPLOADS_DIR, req.params.name);
    await fs.remove(filePath);
    res.status(200).send('Deleted');
  } catch (e) {
    res.status(400).send('Invalid path');
  }
});

// Delete folder and its zip
app.delete('/delete/folder/:name', async (req, res) => {
  try {
    const folderPath = safeJoin(UPLOADS_DIR, req.params.name);
    const zipPath = path.join(UPLOADS_DIR, `${req.params.name}.zip`);
    await fs.remove(folderPath);
    if (await fs.pathExists(zipPath)) await fs.remove(zipPath);
    res.status(200).send('Deleted');
  } catch (e) {
    res.status(400).send('Invalid path');
  }
});

// Delete EVERYTHING (files, folders, zips)
app.delete('/delete/all', async (_req, res) => {
  try {
    const entries = await fs.readdir(UPLOADS_DIR);
    for (const name of entries) {
      const target = path.join(UPLOADS_DIR, name);
      await fs.remove(target);
    }
    res.status(200).send('All deleted');
  } catch (e) {
    res.status(500).send('Failed to purge');
  }
});

// Manually trigger compaction of existing folders
// Raw file (inline) serving with proper MIME (root files & zips)
app.get('/raw/:filename', async (req, res) => {
  try {
    const filePath = safeJoin(UPLOADS_DIR, req.params.filename);
    if (!await fs.pathExists(filePath)) return res.status(404).send('Not found');
    const type = mime.lookup(filePath) || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    fs.createReadStream(filePath).pipe(res);
  } catch { res.status(400).send('Invalid'); }
});

// Text preview (small files)
app.get('/preview/text/:filename', async (req, res) => {
  try {
    const filePath = safeJoin(UPLOADS_DIR, req.params.filename);
    if (!await fs.pathExists(filePath)) return res.status(404).send('Not found');
    const stat = await fs.stat(filePath);
    if (stat.size > 2 * 1024 * 1024) return res.status(413).send('File too large to preview');
    const buf = await fs.readFile(filePath, 'utf8');
    res.type('text/plain').send(buf);
  } catch { res.status(400).send('Invalid'); }
});

// Stats endpoint
// (Removed advanced features for simplicity)

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
