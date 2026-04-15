This design document outlines the architecture for a high-performance, end-to-end encrypted (E2EE), and conflict-free bookmark synchronization engine. The goal is to provide a "Bitwarden-like" experience for native browser bookmark bars.

# ---

**Technical Design Document: Project "Aegis Sync"**

## **1\. Project Overview**

Aegis Sync is an open-source, cross-browser extension that synchronizes native bookmark bars using **CRDTs (Conflict-free Replicated Data Types)** for bulletproof merging and **E2EE** for absolute privacy.

### **Core Pillars**

* **Native-First:** No custom UI for browsing; it manages the browser's own bookmark bar.  
* **Zero-Knowledge:** The server never sees plaintext URLs, titles, or folder structures.  
* **Resilient:** Uses a versioned delta-log to ensure consistency even over flaky connections.  
* **Performant:** Backend written in Rust to minimize latency and hosting costs.

## ---

**2\. System Architecture**

The system consists of three main components: the **Browser Extension (Client)**, the **Rust API (Sequencer)**, and the **PostgreSQL Database (Storage)**.

### **2.1 The Client (TypeScript \+ SolidJS \+ WASM)**

* **CRDT Engine:** Uses **Loro** (Rust-based CRDT) compiled to WASM. This manages the "Source of Truth."  
* **Storage:** **IndexedDB** stores the local Loro document state and a queue of unsynced encrypted deltas.  
* **Native Bridge:** A bi-directional mapper between the chrome.bookmarks API and the Loro Document.  
* **Encryption:** **Web Crypto API** for AES-256-GCM encryption of individual Loro updates.

### **2.2 The Backend (Rust \+ Axum)**

* **Role:** An ordered sequencer. It receives encrypted binary blobs and assigns them a monotonic sequence\_id.  
* **Concurrency:** Built on Tokio for high-concurrency WebSocket handling.  
* **Statelessness:** The API remains stateless, leaning on Postgres for persistence and pub/sub notifications.  
* **Hosting:** The backend will be hosted on fly.io

### **2.3 The Database (PostgreSQL)**

* **Schema:** Optimized for append-only delta logs.  
* **Real-time:** Uses LISTEN/NOTIFY to trigger WebSocket broadcasts when new deltas are committed.

## ---

**3\. Data & Security Model**

### **3.1 Encryption Workflow**

Aegis Sync follows the Bitwarden strategy for key derivation:

1. **Master Password \+ Email** $\\xrightarrow{Argon2id}$ **Master Key**.  
2. **Master Key** $\\xrightarrow{HKDF}$ **Auth Key** (sent to server) AND **Encryption Key** (kept in browser).  
3. **Loro Update (Binary)** $\\xrightarrow{AES-256-GCM}$ **Encrypted Delta**.

### **3.2 Conflict Resolution (CRDT)**

By using Loro, each bookmark action (Create, Move, Rename, Delete) is treated as a deterministic operation.

* **Merging:** If two browsers move the same bookmark to different folders, the CRDT resolves this based on the Loro algorithm (typically favoring the last causal operation) without user intervention.

## ---

**4\. Detailed Component Logic**

### **4.1 The Native "Echo" Filter**

To prevent infinite sync loops, a "Transaction Mutex" is implemented:

* When applying a remote change:  
  1. Set global\_ignore\_flag \= true.  
  2. Execute chrome.bookmarks.create/move.  
  3. Await the browser event, check the flag, discard the outgoing sync, then reset flag.

### **4.2 Profile Switching**

1. The user selects a profile (e.g., "Work").  
2. The extension fetches the full Loro state for that profile\_id.  
3. **Atomic Swap:** All current bookmarks are moved to a temporary "Transition" folder.  
4. The new tree is built in the native bar.  
5. Upon success, the "Transition" folder is purged.

## ---

**5\. API Specification (Rust/Axum)**

| Endpoint | Method | Payload | Description |
| :---- | :---- | :---- | :---- |
| /auth/login | POST | {email, auth\_hash} | Returns JWT and encrypted Profile Metadata. |
| /sync/push | POST | {profile\_id, encrypted\_delta} | Persists a new CRDT op-log entry. |
| /sync/pull | GET | ?since\_seq=123 | Returns all encrypted deltas since sequence\_id. |
| /ws | WebSocket | Upgrade | Real-time notification of new sequence\_ids. |

## ---

**6\. Performance & Efficiency Constraints**

* **Binary Over Wire:** All CRDT deltas are transmitted in Loro's native binary format (compact).  
* **Delta Syncing:** Clients only download missing operations, never the full "World State" unless it's a new device.  
* **Rust Memory Profile:** Target $\<30$MB RAM usage per 1,000 concurrent WebSocket connections.

## ---

**7\. Open Source Implementation Strategy**

* **No Secrets:** Use environment variables for DB strings and JWT secrets.  
* **Web-Ext CLI:** Use standard browser-extension tooling to ensure compatibility across Chromium and Gecko.  
* **GitHub Actions:** Automated builds for the WASM core and the Rust binary.

