const admin = require("firebase-admin");
const path = require("path");

let db;

function initFirebase() {
  if (admin.apps.length > 0) {
    return admin.firestore();
  }

  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const keyPath = path.resolve(
      process.cwd(),
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    );
    const serviceAccount = require(keyPath);
    credential = admin.credential.cert(serviceAccount);
  } else {
    throw new Error("No Firebase credentials found");
  }

  admin.initializeApp({
    credential,
  });

  db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });

  console.log("✅ Firebase initialized");

  return db;
}

function getDb() {
  if (!db) return initFirebase();
  return db;
}

module.exports = { initFirebase, getDb, admin };