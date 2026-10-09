# Student Cloud Hub

A small student dashboard and file manager built with HTML, CSS, and Node.js. Uploaded files are stored on the local machine in `temp_storage`; no cloud storage provider is configured.

## Features

- Upload files using the file picker or drag and drop.
- Browse, preview, and download stored files.
- Filter files by type and organize them into browser-managed folders.
- Keep uploaded file contents and file metadata after a page refresh or server restart.
- Migrate previously uploaded files from this browser's IndexedDB into local server storage when opening the dashboard.

## Requirements

- Node.js 18 or later
- npm

## Run locally

From the project directory:

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Use the local server URL rather than opening the HTML files directly; uploads use the server API.

The server creates `temp_storage` if it does not already exist. Uploaded content is saved there, and `.metadata.json` in that folder keeps the file names, types, sizes, and folder assignments needed to restore the file list at startup.

## Project structure

| File or folder | Purpose |
| --- | --- |
| `server.js` | Express server, local file-storage API, and existing account/profile route definitions |
| `dashboard.html` | Upload interface, file list, previews, filters, and folder controls |
| `login.html` | Login and registration page |
| `style.css` | Login page styles |
| `Student Login.html` | Alternate saved login page |
| `Student Login_files/` | Styles used by the alternate login page |
| `temp_storage/` | Uploaded files and generated storage metadata |
| `package.json` | Node.js dependencies and start command |

## File storage behavior

- New uploads are written to `temp_storage` on the server, not to a cloud service.
- The dashboard requests the file list from the server whenever it loads.
- File contents and metadata persist across browser refreshes and server restarts, as long as `temp_storage` is kept.
- The **Clear All** and **Delete** controls permanently remove files from local storage.
- Folder names and their list are currently kept in the browser's IndexedDB. File-to-folder assignments are stored by the server.

## Current limitations

- Storage is local to the machine running the server. It is not shared across devices and is not a backup service.
- The account and profile routes in `server.js` expect a project-local `db.js` database module. That file is not currently included, so login, registration, and profile operations need a database module before they can work.
- The file-storage API currently has no user authentication or access control. Do not expose this development server to an untrusted network.
