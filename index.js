require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");


// ✅ Import Firebase config
const { initFirebase, getDb, admin } = require("./config/firebase");

// 🔥 Initialize Firebase
initFirebase();
const db = getDb();




const app = express();
app.use(cors());
app.use(bodyParser.json());

/* =========================
   🧪 TEST FIRESTORE
========================= */
app.get("/test-firestore", async (req, res) => {
  try {
    const snapshot = await db.collection("users").limit(1).get();
    res.json({ success: true, count: snapshot.size });
  } catch (error) {
    console.error("❌ Firestore error:", error);
    res.status(500).json({ error: error.message });
  }
});


/* =========================
   🔔 SEND NOTIFICATION
========================= */
app.post("/send-notification", async (req, res) => {
  try {
    const { receiverId, message, chatId } = req.body;

    if (!receiverId || !message) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 🔥 Get receiver token
    const userDoc = await db.collection("users").doc(receiverId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const token = userDoc.data().fcmToken;

    if (!token) {
      return res.status(400).json({ error: "No FCM token found" });
    }

    console.log("📲 Sending to token:", token);

    // 🔥 Send notification
    const response = await admin.messaging().send({
      token: token,
      notification: {
        title: "New Message",
        body: message,
      },
      data: {
        chatId: chatId || "",
      },
    });

    console.log("✅ FCM Response:", response);

    res.json({ success: true, response });
  } catch (error) {
    console.error("❌ Notification error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   🚀 START SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
