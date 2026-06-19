// ============================================================
// api/index.js — Backend Firebase Admin SDK (Vercel)
// Kredensial dibaca dari Environment Variable FIREBASE_SERVICE_ACCOUNT
// (jangan taruh serviceAccountKey.json di GitHub!)
// ============================================================

const express = require('express');
const admin   = require('firebase-admin');
const cors    = require('cors');

const app = express();

// --- Inisialisasi Firebase Admin SDK ---
// Hanya inisialisasi sekali (Vercel bisa reuse instance)
if (!admin.apps.length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        throw new Error('Environment variable FIREBASE_SERVICE_ACCOUNT belum diset di Vercel!');
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential : admin.credential.cert(serviceAccount),
        projectId  : serviceAccount.project_id
    });
}

const db = admin.firestore();

// --- Middleware ---
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// HELPER: Parse nilai khusus Firestore dari JSON client
// ============================================================
function parseSpecialValues(data) {
    if (data === null || data === undefined) return data;
    if (typeof data !== 'object')            return data;
    if (Array.isArray(data))                 return data.map(parseSpecialValues);

    const ft = data.__firestoreType;
    if (ft === 'serverTimestamp') return admin.firestore.FieldValue.serverTimestamp();
    if (ft === 'increment')       return admin.firestore.FieldValue.increment(data.value);
    if (ft === 'delete')          return admin.firestore.FieldValue.delete();

    const result = {};
    for (const [key, value] of Object.entries(data)) {
        result[key] = parseSpecialValues(value);
    }
    return result;
}

// ============================================================
// HELPER: Serialisasi Firestore → JSON biasa
// ============================================================
function serializeValue(value) {
    if (value === null || value === undefined) return value;
    if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
    if (value instanceof admin.firestore.DocumentReference) {
        return { __firestoreType: 'reference', path: value.path };
    }
    if (Array.isArray(value)) return value.map(serializeValue);
    if (typeof value === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(value)) result[k] = serializeValue(v);
        return result;
    }
    return value;
}

function snapToResponse(snap) {
    return {
        _id    : snap.id,
        _exists: snap.exists,
        _data  : snap.exists ? serializeValue(snap.data()) : null,
        _path  : snap.ref.path
    };
}

// ============================================================
// HELPER: Build Firestore query dari constraints
// ============================================================
function buildQuery(baseRef, constraints = []) {
    let q = baseRef;
    for (const c of constraints) {
        switch (c.__constraintType) {
            case 'orderBy'     : q = q.orderBy(c.field, c.dir || 'asc'); break;
            case 'where'       : q = q.where(c.field, c.op, c.value);    break;
            case 'limit'       : q = q.limit(c.value);                   break;
            case 'limitToLast' : q = q.limitToLast(c.value);             break;
        }
    }
    return q;
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/getDoc', async (req, res) => {
    try {
        const snap = await db.doc(req.body.path).get();
        res.json(snapToResponse(snap));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/getDocs', async (req, res) => {
    try {
        const { path, constraints = [] } = req.body;
        const q    = buildQuery(db.collection(path), constraints);
        const snap = await q.get();
        res.json(snap.docs.map(snapToResponse));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/addDoc', async (req, res) => {
    try {
        const ref = await db.collection(req.body.path).add(parseSpecialValues(req.body.data));
        res.json({ id: ref.id, path: ref.path });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/updateDoc', async (req, res) => {
    try {
        await db.doc(req.body.path).update(parseSpecialValues(req.body.data));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/deleteDoc', async (req, res) => {
    try {
        await db.doc(req.body.path).delete();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/setDoc', async (req, res) => {
    try {
        const { path, data, merge = false } = req.body;
        const opts = merge ? { merge: true } : undefined;
        await db.doc(path).set(parseSpecialValues(data), opts);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/writeBatch', async (req, res) => {
    try {
        const batch = db.batch();
        for (const op of req.body.operations) {
            const ref = db.doc(op.path);
            if      (op.type === 'set')    batch.set(ref, parseSpecialValues(op.data), op.merge ? { merge: true } : undefined);
            else if (op.type === 'update') batch.update(ref, parseSpecialValues(op.data));
            else if (op.type === 'delete') batch.delete(ref);
        }
        await batch.commit();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// SSE — real-time onSnapshot
// Catatan Vercel: koneksi SSE dibatasi 60 detik (Hobby) / 300 detik (Pro)
// EventSource di browser otomatis reconnect setelah putus
app.get('/api/snapshot', (req, res) => {
    const { path, type, constraints: constraintsRaw } = req.query;

    res.setHeader('Content-Type',             'text/event-stream');
    res.setHeader('Cache-Control',            'no-cache');
    res.setHeader('Connection',               'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering',        'no');
    res.flushHeaders();

    const send = (data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
        else clearInterval(heartbeat);
    }, 20000);

    let unsubscribe = null;

    try {
        const constraints = constraintsRaw ? JSON.parse(decodeURIComponent(constraintsRaw)) : [];

        if (type === 'doc') {
            unsubscribe = db.doc(path).onSnapshot(
                (snap) => send({ __type: 'doc', ...snapToResponse(snap) }),
                (err)  => send({ __error: err.message })
            );
        } else {
            const q = buildQuery(db.collection(path), constraints);
            unsubscribe = q.onSnapshot(
                (snap) => send({ __type: 'collection', docs: snap.docs.map(snapToResponse) }),
                (err)  => send({ __error: err.message })
            );
        }
    } catch (err) {
        send({ __error: err.message });
    }

    req.on('close', () => {
        clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
        if (!res.writableEnded) res.end();
    });
});

// ============================================================
// EXPORT untuk Vercel (jangan pakai app.listen!)
// ============================================================
module.exports = app;
