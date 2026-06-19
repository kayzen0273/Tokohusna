// ============================================================
// firebase-proxy.js
// Pengganti Firebase Client SDK (browser) untuk Sistem Kasir
//
// Cara kerja:
//  - Semua panggilan window.collection / window.doc / dll.
//    diteruskan ke backend server.js via fetch() & EventSource
//  - Backend menggunakan Firebase Admin SDK (bypass security rules)
//  - Tidak ada perubahan diperlukan pada logika HTML utama
//
// Pastikan server.js sudah berjalan di port 3001 sebelum
// membuka aplikasi HTML ini.
// ============================================================

(function () {
    'use strict';

    // --------------------------------------------------------
    // KONFIGURASI – ganti PORT jika server berjalan di port lain
    // --------------------------------------------------------
    const BACKEND_URL = ''; // Vercel: frontend & backend satu domain

    // --------------------------------------------------------
    // Generator ID 20 karakter (seperti ID Firestore)
    // --------------------------------------------------------
    function newId() {
        const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let id = '';
        for (let i = 0; i < 20; i++) id += c[Math.floor(Math.random() * 62)];
        return id;
    }

    // --------------------------------------------------------
    // KELAS REFERENSI (tiruan Firebase ref objects)
    // --------------------------------------------------------
    class DocRef {
        constructor(path) {
            this._path = path;
            this._type = 'doc';
            this.id    = path.split('/').pop();
        }
    }

    class CollRef {
        constructor(path) {
            this._path = path;
            this._type = 'collection';
            this.id    = path.split('/').pop();
        }
    }

    class QueryRef {
        constructor(path, constraints) {
            this._path       = path;
            this._type       = 'query';
            this.constraints = constraints;
        }
    }

    // --------------------------------------------------------
    // NILAI KHUSUS FIRESTORE
    // Dikirim sebagai objek JSON ke server, dikonversi jadi
    // FieldValue di server.js
    // --------------------------------------------------------
    window.serverTimestamp = () => ({ __firestoreType: 'serverTimestamp' });
    window.increment       = (n) => ({ __firestoreType: 'increment', value: n });
    window.deleteField     = ()  => ({ __firestoreType: 'delete' });

    // --------------------------------------------------------
    // DATABASE DUMMY (hanya placeholder)
    // --------------------------------------------------------
    window.db = { __isProxyDb: true };

    // --------------------------------------------------------
    // FUNGSI REFERENSI FIRESTORE
    // --------------------------------------------------------

    // collection(db, 'seg1', 'seg2', ...) atau collection(docRef, 'sub')
    window.collection = function (dbOrRef) {
        const segments = Array.prototype.slice.call(arguments, 1);
        if (dbOrRef instanceof DocRef || dbOrRef instanceof CollRef) {
            return new CollRef(dbOrRef._path + '/' + segments.join('/'));
        }
        return new CollRef(segments.join('/'));
    };

    // doc(db, 'seg1', ..., 'id') atau doc(colRef, 'id') atau doc(colRef) → auto-ID
    window.doc = function (dbOrRef) {
        const segments = Array.prototype.slice.call(arguments, 1);
        if (dbOrRef instanceof CollRef || dbOrRef instanceof QueryRef) {
            const id = segments.length > 0 ? segments.join('/') : newId();
            return new DocRef(dbOrRef._path + '/' + id);
        }
        return new DocRef(segments.join('/'));
    };

    // --------------------------------------------------------
    // CONSTRAINT BUILDERS
    // --------------------------------------------------------
    window.query       = function (ref) {
        const constraints = Array.prototype.slice.call(arguments, 1);
        return new QueryRef(ref._path, constraints);
    };
    window.orderBy     = (field, dir)         => ({ __constraintType: 'orderBy', field, dir: dir || 'asc' });
    window.where       = (field, op, value)   => ({ __constraintType: 'where', field, op, value });
    window.limit       = (n)                  => ({ __constraintType: 'limit', value: n });
    window.limitToLast = (n)                  => ({ __constraintType: 'limitToLast', value: n });

    // --------------------------------------------------------
    // HELPER: Panggil backend via POST fetch
    // --------------------------------------------------------
    async function api(endpoint, body) {
        const res = await fetch(BACKEND_URL + endpoint, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify(body)
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => res.statusText);
            throw new Error('[Firebase Proxy ' + endpoint + '] ' + txt);
        }
        return res.json();
    }

    // --------------------------------------------------------
    // HELPER: Buat DocumentSnapshot dari data backend
    // --------------------------------------------------------
    function makeDocSnap(item) {
        return {
            id    : item._id,
            exists: function () { return item._exists !== false; },
            data  : function () { return item._data || null; },
            get   : function (f) { return item._data ? item._data[f] : undefined; }
        };
    }

    // HELPER: Buat QuerySnapshot dari array docs
    function makeQuerySnap(docs) {
        const snaps = docs.map(makeDocSnap);
        return {
            docs    : snaps,
            empty   : snaps.length === 0,
            size    : snaps.length,
            forEach : function (cb) { snaps.forEach(cb); },
            docChanges: function () {
                return snaps.map(function (d, i) {
                    return { type: 'added', doc: d, oldIndex: -1, newIndex: i };
                });
            }
        };
    }

    // --------------------------------------------------------
    // CRUD OPERATIONS
    // --------------------------------------------------------

    window.getDoc = function (ref) {
        return api('/api/getDoc', { path: ref._path }).then(makeDocSnap);
    };

    window.getDocs = function (refOrQuery) {
        return api('/api/getDocs', {
            path       : refOrQuery._path,
            constraints: refOrQuery.constraints || []
        }).then(makeQuerySnap);
    };

    window.addDoc = function (ref, data) {
        return api('/api/addDoc', { path: ref._path, data: data });
    };

    window.updateDoc = function (ref, data) {
        return api('/api/updateDoc', { path: ref._path, data: data });
    };

    window.deleteDoc = function (ref) {
        return api('/api/deleteDoc', { path: ref._path });
    };

    window.setDoc = function (ref, data, options) {
        return api('/api/setDoc', {
            path : ref._path,
            data : data,
            merge: (options && options.merge) ? true : false
        });
    };

    // --------------------------------------------------------
    // WRITE BATCH
    // --------------------------------------------------------
    window.writeBatch = function (_db) {
        var ops = [];
        var batch = {
            set: function (ref, data, options) {
                ops.push({ type: 'set', path: ref._path, data: data, merge: (options && options.merge) ? true : false });
                return batch;
            },
            update: function (ref, data) {
                ops.push({ type: 'update', path: ref._path, data: data });
                return batch;
            },
            delete: function (ref) {
                ops.push({ type: 'delete', path: ref._path });
                return batch;
            },
            commit: function () {
                return api('/api/writeBatch', { operations: ops });
            }
        };
        return batch;
    };

    // --------------------------------------------------------
    // ON SNAPSHOT (real-time listener via SSE)
    // Mengembalikan fungsi unsubscribe, persis seperti Firebase
    // --------------------------------------------------------
    window.onSnapshot = function (refOrQuery, callback, errorCallback) {
        var path        = refOrQuery._path;
        var type        = (refOrQuery instanceof DocRef) ? 'doc' : 'collection';
        var constraints = refOrQuery.constraints
            ? encodeURIComponent(JSON.stringify(refOrQuery.constraints))
            : encodeURIComponent('[]');

        var url    = BACKEND_URL + '/api/snapshot?path=' + encodeURIComponent(path)
                     + '&type=' + type
                     + '&constraints=' + constraints;
        var source = null;
        var closed = false;

        function connect() {
            if (closed) return;
            source = new EventSource(url);

            source.onmessage = function (e) {
                try {
                    var data = JSON.parse(e.data);
                    if (data.__error) {
                        if (typeof errorCallback === 'function') errorCallback(new Error(data.__error));
                        return;
                    }
                    if (data.__type === 'doc') {
                        callback(makeDocSnap(data));
                    } else {
                        callback(makeQuerySnap(data.docs));
                    }
                } catch (err) {
                    console.error('[Firebase Proxy] onSnapshot parse error:', err);
                }
            };

            source.onerror = function () {
                if (!closed) {
                    // EventSource otomatis reconnect setelah error
                }
            };
        }

        connect();

        // Kembalikan fungsi unsubscribe (sama persis seperti Firebase)
        return function () {
            closed = true;
            if (source) { source.close(); source = null; }
        };
    };

    // --------------------------------------------------------
    // AUTH SIMULASI
    // Backend Admin SDK sudah bypass security rules, jadi kita
    // hanya perlu user object palsu agar logika app berjalan.
    // UID disimpan di localStorage agar konsisten antar sesi.
    // --------------------------------------------------------
    var UID_KEY = 'kasir_proxy_uid';
    var uid     = null;
    try { uid = localStorage.getItem(UID_KEY); } catch (_) {}
    if (!uid) {
        uid = 'proxy-' + newId();
        try { localStorage.setItem(UID_KEY, uid); } catch (_) {}
    }

    var mockUser = { uid: uid, email: null, isAnonymous: true, displayName: null };
    var _authUser = null;
    var _authListeners = [];

    window.auth = {
        get currentUser() { return _authUser; }
    };

    window.onAuthStateChanged = function (_auth, callback) {
        _authListeners.push(callback);
        // Panggil segera dengan state saat ini
        var u = _authUser;
        setTimeout(function () { callback(u); }, 0);
        return function () {
            var i = _authListeners.indexOf(callback);
            if (i >= 0) _authListeners.splice(i, 1);
        };
    };

    function _setUser(user) {
        _authUser = user;
        _authListeners.forEach(function (cb) { cb(user); });
    }

    window.signInAnonymously = function (_auth) {
        _setUser(mockUser);
        return Promise.resolve({ user: mockUser });
    };

    window.signInWithCustomToken = function (_auth, _token) {
        _setUser(mockUser);
        return Promise.resolve({ user: mockUser });
    };

    // --------------------------------------------------------
    // APP ID & INITIAL AUTH TOKEN (kompatibel dengan platform)
    // --------------------------------------------------------
    window.appId             = (typeof __app_id !== 'undefined') ? __app_id : 'default-app-id';
    window.initialAuthToken  = (typeof __initial_auth_token !== 'undefined') ? __initial_auth_token : null;

    // --------------------------------------------------------
    // LOG SUKSES
    // --------------------------------------------------------
    console.log('%c[Firebase Proxy] ✅ Loaded – semua operasi diarahkan ke backend', 'color:#22c55e;font-weight:bold');
    console.log('%c[Firebase Proxy] Backend: ' + BACKEND_URL + '  |  UID: ' + uid, 'color:#6366f1');

})();
