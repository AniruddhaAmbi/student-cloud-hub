require("dotenv").config();
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { pipeline } = require("stream/promises");

const app = express();
app.use(express.json());
app.use(cors());

const storageDirectory = path.join(__dirname, "temp_storage");
const manifestPath = path.join(storageDirectory, ".metadata.json");
const storedFiles = new Map();
let manifestWrite = Promise.resolve();

fs.mkdirSync(storageDirectory, { recursive: true });

function filePathFor(record) {
  return path.join(storageDirectory, record.storedName);
}

function saveManifest() {
  const snapshot = JSON.stringify(Array.from(storedFiles.values(), (record) => ({
    ...record
  })), null, 2);
  const write = manifestWrite.catch(() => {}).then(async () => {
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryPath, snapshot, "utf8");
      await fs.promises.rename(temporaryPath, manifestPath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true });
      throw error;
    }
  });
  manifestWrite = write;
  return write;
}

async function loadStoredFiles() {
  if (fs.existsSync(manifestPath)) {
    const records = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(records)) {
      throw new Error("File storage metadata must contain an array");
    }

    for (const record of records) {
      if (
        typeof record.id !== "string" ||
        typeof record.storedName !== "string" ||
        path.basename(record.storedName) !== record.storedName ||
        typeof record.name !== "string"
      ) {
        throw new Error("File storage metadata contains an invalid record");
      }
      if (fs.existsSync(filePathFor(record))) {
        storedFiles.set(record.id, record);
      }
    }
  }

  let recoveredFiles = false;
  for (const entry of fs.readdirSync(storageDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) {
      continue;
    }
    if (Array.from(storedFiles.values()).some((record) => record.storedName === entry.name)) {
      continue;
    }

    const id = randomUUID();
    const recoveredName = entry.name.match(/^[0-9a-f-]{36}--(.+)$/i);
    const filePath = path.join(storageDirectory, entry.name);
    const stats = fs.statSync(filePath);
    storedFiles.set(id, {
      id,
      storedName: entry.name,
      name: recoveredName ? recoveredName[1] : entry.name,
      type: "application/octet-stream",
      size: stats.size,
      date: stats.mtimeMs,
      folderId: null
    });
    recoveredFiles = true;
  }

  if (recoveredFiles) {
    await saveManifest();
  }
}

function publicFile(record) {
  const { storedName, importKey, ...file } = record;
  return {
    ...file,
    contentUrl: `/api/files/${encodeURIComponent(record.id)}/content`
  };
}

function safeFileName(name) {
  const basename = path.basename(name.replace(/[\\/]/g, "_"));
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "upload";
}

function getDatabase(res) {
  try {
    return require("./db");
  } catch (error) {
    console.error("Database service is unavailable:", error.message);
    res.status(503).send("Database service unavailable");
    return null;
  }
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/dashboard.html", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css")));
app.get("/Student%20Login_files/style.css", (req, res) =>
  res.sendFile(path.join(__dirname, "Student Login_files", "style.css"))
);

app.get("/api/files", (req, res) => {
  const files = Array.from(storedFiles.values())
    .sort((a, b) => b.date - a.date)
    .map(publicFile);
  res.json(files);
});

app.post("/api/files", async (req, res) => {
  let name;
  try {
    name = decodeURIComponent(req.get("X-File-Name") || "");
  } catch {
    return res.status(400).json({ error: "Invalid file name" });
  }
  if (!name || name.length > 255) {
    return res.status(400).json({ error: "A valid file name is required" });
  }

  const importKey = req.get("X-Import-Key");
  if (importKey && (importKey.length > 255 || /[\u0000-\u001f\u007f]/.test(importKey))) {
    return res.status(400).json({ error: "Invalid import key" });
  }
  if (importKey) {
    const existing = Array.from(storedFiles.values()).find((record) => record.importKey === importKey);
    if (existing) {
      req.resume();
      req.on("end", () => res.json(publicFile(existing)));
      req.on("error", (error) => {
        console.error("Failed to finish duplicate file import:", error);
        if (!res.headersSent) res.status(400).json({ error: "Failed to import file" });
      });
      return;
    }
  }

  const id = randomUUID();
  const originalName = safeFileName(name);
  const storedName = `${id}--${originalName}`;
  const temporaryPath = path.join(storageDirectory, `.uploading-${id}`);
  const destinationPath = path.join(storageDirectory, storedName);

  try {
    await pipeline(req, fs.createWriteStream(temporaryPath, { flags: "wx" }));
    const stats = await fs.promises.stat(temporaryPath);
    await fs.promises.rename(temporaryPath, destinationPath);

    const folderHeader = req.get("X-Folder-Id");
    const record = {
      id,
      storedName,
      name: originalName,
      type: (req.get("X-File-Type") || "application/octet-stream").slice(0, 200),
      size: stats.size,
      date: Date.now(),
      folderId: folderHeader || null,
      ...(importKey ? { importKey } : {})
    };
    storedFiles.set(id, record);
    try {
      await saveManifest();
    } catch (error) {
      storedFiles.delete(id);
      await fs.promises.rm(destinationPath, { force: true });
      throw error;
    }
    res.status(201).json(publicFile(record));
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true });
    console.error("Failed to store uploaded file:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to store uploaded file" });
    }
  }
});

app.get("/api/files/:id/content", (req, res) => {
  const record = storedFiles.get(req.params.id);
  if (!record) return res.status(404).json({ error: "File not found" });

  if (req.query.download === "1") {
    return res.download(filePathFor(record), record.name);
  }
  res.type(record.type).sendFile(filePathFor(record));
});

app.put("/api/files/:id", async (req, res) => {
  const record = storedFiles.get(req.params.id);
  if (!record) return res.status(404).json({ error: "File not found" });
  const { folderId } = req.body;
  if (folderId !== null && typeof folderId !== "string" && typeof folderId !== "number") {
    return res.status(400).json({ error: "Invalid folder id" });
  }

  const updated = { ...record, folderId };
  storedFiles.set(updated.id, updated);
  try {
    await saveManifest();
    res.json(publicFile(updated));
  } catch (error) {
    storedFiles.set(record.id, record);
    console.error("Failed to update stored file metadata:", error);
    res.status(500).json({ error: "Failed to update file" });
  }
});

app.delete("/api/files/:id", async (req, res) => {
  const record = storedFiles.get(req.params.id);
  if (!record) return res.status(404).json({ error: "File not found" });

  try {
    await fs.promises.rm(filePathFor(record));
    storedFiles.delete(record.id);
    await saveManifest();
    res.status(204).end();
  } catch (error) {
    console.error("Failed to delete stored file:", error);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

app.delete("/api/files", async (req, res) => {
  try {
    await Promise.all(Array.from(storedFiles.values(), (record) =>
      fs.promises.rm(filePathFor(record), { force: true })
    ));
    storedFiles.clear();
    await saveManifest();
    res.status(204).end();
  } catch (error) {
    console.error("Failed to clear stored files:", error);
    res.status(500).json({ error: "Failed to clear stored files" });
  }
});

const SECRET_KEY = "studentcloudsecret";

// REGISTER
app.post("/register", async (req, res) => {
  const db = getDatabase(res);
  if (!db) return;
  const { name, email, password, course } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  db.query(
    "INSERT INTO users (name,email,password,course) VALUES (?,?,?,?)",
    [name, email, hashedPassword, course],
    (err) => {
      if (err) return res.status(400).send("User already exists");
      res.send("Registered Successfully");
    }
  );
});

// LOGIN
app.post("/login", (req, res) => {
  const db = getDatabase(res);
  if (!db) return;
  const { email, password } = req.body;

  db.query("SELECT * FROM users WHERE email=?", [email], async (err, result) => {
    if (err || result.length === 0)
      return res.status(400).send("Invalid Credentials");

    const user = result[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).send("Invalid Password");

    const token = jwt.sign({ id: user.id }, SECRET_KEY);
    res.json({ token });
  });
});

// VERIFY TOKEN
function verifyToken(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.status(403).send("Access Denied");

  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).send("Invalid Token");
    req.userId = decoded.id;
    next();
  });
}

// DASHBOARD DATA
app.get("/dashboard", verifyToken, (req, res) => {
  const db = getDatabase(res);
  if (!db) return;
  db.query("SELECT id,name,email,course,semester,gpa,phone,enrollDate,bio FROM users WHERE id=?", [req.userId], 
    (err, result) => {
      if (err) return res.status(500).json({ error: "Failed to fetch data" });
      res.json(result[0]);
    });
});

// UPDATE STUDENT PROFILE
app.put("/update-profile", verifyToken, (req, res) => {
  const db = getDatabase(res);
  if (!db) return;
  const { name, course, semester, gpa, phone, enrollDate, bio } = req.body;
  
  db.query(
    "UPDATE users SET name=?, course=?, semester=?, gpa=?, phone=?, enrollDate=?, bio=? WHERE id=?",
    [name, course, semester, gpa, phone, enrollDate, bio, req.userId],
    (err) => {
      if (err) return res.status(500).json({ error: "Failed to update profile" });
      res.json({ message: "Profile updated successfully" });
    }
  );
});

loadStoredFiles()
  .then(() => app.listen(3000, () => console.log("Server running on port 3000")))
  .catch((error) => {
    console.error("Failed to initialize file storage:", error);
    process.exitCode = 1;
  });