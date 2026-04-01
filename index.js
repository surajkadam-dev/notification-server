require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const bodyParser = require("body-parser");

// Parse service account from ENV


// Fix private key formatting

console.log("PROJECT_ID:", process.env.FIREBASE_PROJECT_ID1);
console.log("CLIENT_EMAIL:", process.env.FIREBASE_CLIENT_EMAIL);
console.log("PRIVATE_KEY EXISTS:", !!process.env.FIREBASE_PRIVATE_KEY);
// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID1,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Health check route
app.get("/", (req, res) => {
  res.send("🚀 Notification server is running");
});

// 🔔 Send notification API
app.post("/send-notification", async (req, res) => {
  try {
    const { receiverId, message, chatId } = req.body;

    if (!receiverId || !message) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // Get user FCM token
    const userDoc = await db.collection("users").doc(receiverId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const token = userDoc.data().fcmToken;

    if (!token) {
      return res.status(400).json({ error: "No FCM token found" });
    }

    // Send notification
    await admin.messaging().send({
      token: token,
      notification: {
        title: "New Message",
        body: message,
      },
      data: {
        chatId: chatId || "",
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
