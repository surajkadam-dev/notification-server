require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

// ✅ Import Firebase config (your existing setup)
const { initFirebase, getDb, admin } = require("./config/firebase");

// 🔥 Initialize Firebase
initFirebase();
const db = getDb();

const app = express();

// ---------- Middleware ----------
app.use(cors());
// Normal JSON parsing for most routes
app.use(express.json());

// For webhook (must be raw body to verify signature)
app.use("/webhook", express.raw({ type: "application/json" }));

// ---------- Razorpay instance ----------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
console.log("key: ",process.env.RAZORPAY_KEY_ID)
console.log("screate: ",process.env.RAZORPAY_KEY_SECRET)
// ---------- Helper: Verify Firebase ID Token ----------
async function authenticate(req, res, next) {
  const token = req.headers.authorization?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ---------- Helper: Check admin role (custom claim) ----------
async function isAdmin(userId) {
  const user = await admin.auth().getUser(userId);
  return user.customClaims?.admin === true;
}

// ========== 1. TEST FIRESTORE (your existing endpoint) ==========
app.get("/test-firestore", async (req, res) => {
  try {
    const snapshot = await db.collection("users").limit(1).get();
    res.json({ success: true, count: snapshot.size });
  } catch (error) {
    console.error("❌ Firestore error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ========== 2. SEND NOTIFICATION (your existing endpoint) ==========
app.post("/send-notification", async (req, res) => {
  try {
    const { receiverId, message, chatId } = req.body;
    if (!receiverId || !message) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const userDoc = await db.collection("users").doc(receiverId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }
    const token = userDoc.data().fcmToken;
    if (!token) {
      return res.status(400).json({ error: "No FCM token found" });
    }
    console.log("📲 Sending to token:", token);
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

// ========== 3. CREATE ORDER ==========
app.post("/create-order", authenticate, async (req, res) => {
  const { chatId } = req.body;
  const userId = req.user.uid;
  console.log("create order: ",req.body);

  try {
    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return res.status(404).json({ error: "Chat not found" });
    const chat = chatDoc.data();

    if (chat.ownerId !== userId) {
      return res.status(403).json({ error: "Only owner can initiate payment" });
    }

    const amount = chat.finalAmount;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const options = {
      amount: amount * 100, // paise
      currency: "INR",
      receipt: `chat_${chatId}`,
      notes: { chatId, ownerId: userId, helperId: chat.helperId },
    };
    const order = await razorpay.orders.create(options);
    console.log({
      orderId:order.id,
      amount:amount,
      currency:"INR"
    })
    res.json({
      orderId: order.id,
      amount: amount,
      currency: "INR",
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ========== 4. VERIFY PAYMENT (Client‑triggered) ==========
app.post("/verify-payment", authenticate, async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    chatId,
  } = req.body;
  const userId = req.user.uid;

  try {
    // 1. Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");
    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    // 2. Fetch chat (never trust frontend amount)
    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return res.status(404).json({ error: "Chat not found" });
    const chat = chatDoc.data();

    if (chat.ownerId !== userId) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // 3. Calculate backend values
    const amount = chat.finalAmount;
    const platformFee = Math.round(amount * 0.1);
    const helperAmount = amount - platformFee;

    // 4. Idempotency: check if already processed
    const existingTx = await db
      .collection("transactions")
      .where("razorpayPaymentId", "==", razorpay_payment_id)
      .limit(1)
      .get();
    if (!existingTx.empty) {
      return res.status(409).json({ error: "Transaction already processed" });
    }

    // 5. Create transaction document
    const transactionId = db.collection("transactions").doc().id;
    const transaction = {
      id: transactionId,
      chatId,
      ownerId: chat.ownerId,
      helperId: chat.helperId,
      amount,
      platformFee,
      helperAmount,
      status: "escrow",
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection("transactions").doc(transactionId).set(transaction);

    // 6. Update chat payment status
    await chatRef.update({ paymentStatus: "escrow" });

    res.json({ success: true, transactionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ========== 5. WEBHOOK (Backup) ==========
app.post("/webhook", async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  const body = req.body.toString();
  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(body)
    .digest("hex");
  if (signature !== expectedSignature) {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const event = JSON.parse(body);
  if (event.event === "payment.captured") {
    const payment = event.payload.payment.entity;
    const razorpayPaymentId = payment.id;
    const razorpayOrderId = payment.order_id;

    // Retrieve order to get chatId from notes
    const order = await razorpay.orders.fetch(razorpayOrderId);
    const chatId = order.notes?.chatId;
    if (!chatId) return res.status(400).json({ error: "ChatId missing in order notes" });

    // Check if already processed
    const existingTx = await db
      .collection("transactions")
      .where("razorpayPaymentId", "==", razorpayPaymentId)
      .limit(1)
      .get();
    if (!existingTx.empty) return res.status(200).json({ received: true });

    // Fetch chat from Firestore
    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return res.status(404).json({ error: "Chat not found" });
    const chat = chatDoc.data();

    const amount = chat.finalAmount;
    const platformFee = Math.round(amount * 0.1);
    const helperAmount = amount - platformFee;

    const transactionId = db.collection("transactions").doc().id;
    const transaction = {
      id: transactionId,
      chatId,
      ownerId: chat.ownerId,
      helperId: chat.helperId,
      amount,
      platformFee,
      helperAmount,
      status: "escrow",
      razorpayOrderId,
      razorpayPaymentId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection("transactions").doc(transactionId).set(transaction);
    await chatRef.update({ paymentStatus: "escrow" });
  }
  res.status(200).json({ received: true });
});

// ========== 6. HELPER MARKS WORK COMPLETED ==========
app.post("/complete-work", authenticate, async (req, res) => {
  const { chatId } = req.body;
  const userId = req.user.uid;

  const chatRef = db.collection("chats").doc(chatId);
  const chatDoc = await chatRef.get();
  if (!chatDoc.exists) return res.status(404).json({ error: "Chat not found" });
  const chat = chatDoc.data();
  if (chat.helperId !== userId) {
    return res.status(403).json({ error: "Only helper can mark work completed" });
  }
  if (chat.paymentStatus !== "escrow") {
    return res.status(400).json({ error: "Payment not in escrow" });
  }
  await chatRef.update({ paymentStatus: "completed" });
  res.json({ success: true });
});

// ========== 7. OWNER RELEASES PAYMENT ==========
app.post("/release-payment", authenticate, async (req, res) => {
  const { chatId } = req.body;
  const userId = req.user.uid;

  const chatRef = db.collection("chats").doc(chatId);
  const chatDoc = await chatRef.get();
  if (!chatDoc.exists) return res.status(404).json({ error: "Chat not found" });
  const chat = chatDoc.data();
  if (chat.ownerId !== userId) {
    return res.status(403).json({ error: "Only owner can release payment" });
  }
  if (chat.paymentStatus !== "completed") {
    return res.status(400).json({ error: "Work not marked as completed yet" });
  }

  // Get transaction
  const txQuery = await db
    .collection("transactions")
    .where("chatId", "==", chatId)
    .limit(1)
    .get();
  if (txQuery.empty) return res.status(404).json({ error: "Transaction not found" });
  const txDoc = txQuery.docs[0];
  const transaction = txDoc.data();

  // Firestore transaction to update wallet & records
  await db.runTransaction(async (t) => {
    t.update(txDoc.ref, { status: "released" });
    t.update(chatRef, { paymentStatus: "released" });

    const walletRef = db.collection("wallets").doc(transaction.helperId);
    const walletDoc = await t.get(walletRef);
    const currentBalance = walletDoc.exists ? walletDoc.data().balance : 0;
    const currentEarnings = walletDoc.exists ? walletDoc.data().totalEarnings : 0;
    t.set(
      walletRef,
      {
        userId: transaction.helperId,
        balance: currentBalance + transaction.helperAmount,
        totalEarnings: currentEarnings + transaction.helperAmount,
        totalWithdrawn: walletDoc.exists ? walletDoc.data().totalWithdrawn : 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const walletTxRef = db.collection("wallet_transactions").doc();
    t.set(walletTxRef, {
      id: walletTxRef.id,
      userId: transaction.helperId,
      type: "credit",
      amount: transaction.helperAmount,
      source: "job_payment",
      referenceId: transaction.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  res.json({ success: true });
});

// ========== 8. GET WALLET BALANCE ==========
app.get("/wallet", authenticate, async (req, res) => {
  const userId = req.user.uid;
  const walletDoc = await db.collection("wallets").doc(userId).get();
  const balance = walletDoc.exists ? walletDoc.data().balance : 0;
  res.json({ balance });
});

// ========== 9. REQUEST WITHDRAWAL ==========
app.post("/withdraw-request", authenticate, async (req, res) => {
  const { amount, upiId } = req.body;
  const userId = req.user.uid;

  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (!upiId) return res.status(400).json({ error: "UPI ID required" });

  const walletRef = db.collection("wallets").doc(userId);
  const walletDoc = await walletRef.get();
  const balance = walletDoc.exists ? walletDoc.data().balance : 0;
  if (amount > balance) {
    return res.status(400).json({ error: "Insufficient balance" });
  }

  const requestId = db.collection("withdrawal_requests").doc().id;
  await db.collection("withdrawal_requests").doc(requestId).set({
    id: requestId,
    userId,
    amount,
    upiId,
    status: "pending",
    requestedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  res.json({ success: true, requestId });
});

// ========== 10. PROCESS WITHDRAWAL (ADMIN ONLY) ==========
app.post("/process-withdrawal", authenticate, async (req, res) => {
  const { requestId } = req.body;
  const userId = req.user.uid;

  const adminCheck = await isAdmin(userId);
  if (!adminCheck) return res.status(403).json({ error: "Admin access required" });

  const requestRef = db.collection("withdrawal_requests").doc(requestId);
  const requestDoc = await requestRef.get();
  if (!requestDoc.exists) return res.status(404).json({ error: "Request not found" });
  const request = requestDoc.data();
  if (request.status !== "pending") {
    return res.status(400).json({ error: "Request already processed" });
  }

  const walletRef = db.collection("wallets").doc(request.userId);
  await db.runTransaction(async (t) => {
    const walletDoc = await t.get(walletRef);
    const currentBalance = walletDoc.data().balance;
    if (currentBalance < request.amount) {
      throw new Error("Insufficient balance");
    }
    t.update(walletRef, {
      balance: currentBalance - request.amount,
      totalWithdrawn: (walletDoc.data().totalWithdrawn || 0) + request.amount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    t.update(requestRef, {
      status: "paid",
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const walletTxRef = db.collection("wallet_transactions").doc();
    t.set(walletTxRef, {
      id: walletTxRef.id,
      userId: request.userId,
      type: "debit",
      amount: request.amount,
      source: "withdrawal",
      referenceId: requestId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  res.json({ success: true });
});

// ========== 11. ADMIN: GET PENDING WITHDRAWALS ==========
app.get("/admin/pending-withdrawals", authenticate, async (req, res) => {
  const userId = req.user.uid;
  const adminCheck = await isAdmin(userId);
  if (!adminCheck) return res.status(403).json({ error: "Admin only" });

  const snapshot = await db
    .collection("withdrawal_requests")
    .where("status", "==", "pending")
    .orderBy("requestedAt", "asc")
    .get();
  const requests = snapshot.docs.map((doc) => doc.data());
  res.json(requests);
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});