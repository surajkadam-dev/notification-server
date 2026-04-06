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
app.get("/env-check", (req, res) => {
  res.json({
    key: process.env.RAZORPAY_KEY_ID ? "OK" : "MISSING",
    secret: process.env.RAZORPAY_KEY_SECRET ? "OK" : "MISSING",
    webhook: process.env.RAZORPAY_WEBHOOK_SECRET ? "OK" : "MISSING",
  });
});
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
  console.log("payment verified: ");

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
 if(!chat.gigId){
   return res.status(400).json({error:"gigId missing"});
 }
      const gigRef=db.collection("gigs").doc(chat.gigId);
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
    await gigRef.update({ paymentStatus: "escrow" });

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
console.log("webhook hit");
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
  await chatRef.set({ paymentStatus: "completed" ,completedAt:new Date()},{merge:true});
  res.json({ success: true });
});

app.post("/approve-work", authenticate, async (req, res) => {
  try {
    const { chatId } = req.body;
    const userId = req.user.uid;

    if (!chatId) {
      return res.status(400).json({ error: "chatId is required" });
    }

    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();

    if (!chatDoc.exists) {
      return res.status(404).json({ error: "Chat not found" });
    }

    const chat = chatDoc.data();

    // ✅ Only owner can approve
    if (chat.ownerId !== userId) {
      return res.status(403).json({ error: "Only owner can approve work" });
    }

    // ✅ Work must be completed first
    if (chat.paymentStatus !== "completed") {
      return res.status(400).json({ error: "Work not marked as completed yet" });
    }

    // 🔥 GET TRANSACTION
    const txQuery = await db
      .collection("transactions")
      .where("chatId", "==", chatId)
      .limit(1)
      .get();

    if (txQuery.empty) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    const txDoc = txQuery.docs[0];
    const transaction = txDoc.data();

    // 🔥 FIRESTORE TRANSACTION (FIXED ORDER)
    await db.runTransaction(async (t) => {

      // ✅ 1. READ FIRST (VERY IMPORTANT)
      const walletRef = db.collection("wallets").doc(transaction.helperId);
      const walletDoc = await t.get(walletRef);

      const currentBalance = walletDoc.exists
        ? walletDoc.data().balance || 0
        : 0;

      const currentEarnings = walletDoc.exists
        ? walletDoc.data().totalEarnings || 0
        : 0;

      const currentWithdrawn = walletDoc.exists
        ? walletDoc.data().totalWithdrawn || 0
        : 0;
      const gigRef=db.collection("gigs").doc(chat.gigId);

      // ✅ 2. THEN WRITE

      // Update transaction
      t.update(txDoc.ref, {
        status: "released",
        releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update chat (🔥 clears dispute)
      t.update(chatRef, {
        paymentStatus: "released",
        hasDispute: false,
        disputeReason: admin.firestore.FieldValue.delete(),
        releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      t.set(gigRef,{
        status:"completed",
        paymentStatus:"released",
        completedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});

      // Update wallet
      t.set(
        walletRef,
        {
          userId: transaction.helperId,
          balance: currentBalance + transaction.helperAmount,
          totalEarnings: currentEarnings + transaction.helperAmount,
          totalWithdrawn: currentWithdrawn,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // Wallet transaction log
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

    return res.json({
      success: true,
      message: "Work approved & payment released successfully",
    });

  } catch (error) {
    console.error("Approve work error:", error);

    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// ========== 7. OWNER RELEASES PAYMENT ==========


// ========== 8. GET WALLET BALANCE ==========
app.get("/wallet", authenticate, async (req, res) => {
  const userId = req.user.uid;
  const walletDoc = await db.collection("wallets").doc(userId).get();
  const balance = walletDoc.exists ? walletDoc.data().balance : 0;
  res.json({ balance });
});

app.post("/withdraw", authenticate, async (req, res) => {
  const { amount, upiId } = req.body;
  const userId = req.user.uid;

  if (!amount || amount <= 0 || !upiId) {
    return res.status(400).json({ error: "Invalid input" });
  }

  try {
    const walletRef = db.collection("wallets").doc(userId);
    const reqRef = db.collection("withdrawal_requests").doc();

    await db.runTransaction(async (t) => {
      // 🔹 READ wallet (IMPORTANT for rules)
      const walletDoc = await t.get(walletRef);

      const balance = walletDoc.exists ? walletDoc.data().balance : 0;

      if (balance < amount) {
        throw new Error("Insufficient balance");
      }

      // 🔻 Deduct balance immediately
      t.set(walletRef, {
        userId,
        balance: balance - amount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // 📄 Create withdrawal request
      t.set(reqRef, {
        id: reqRef.id,
        userId,
        amount,
        upiId,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 🧾 Wallet transaction log
      const txRef = db.collection("wallet_transactions").doc();
      t.set(txRef, {
        id: txRef.id,
        userId,
        type: "debit",
        amount,
        source: "withdraw_request",
        referenceId: reqRef.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ success: true });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get("/withdrawals", authenticate, async (req, res) => {
  const userId = req.user.uid;

  try {
    const snapshot = await db
      .collection("withdrawal_requests")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    const data = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ success: true, data });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/withdrawals", authenticate, async (req, res) => {
  try {
    if(req.user.role !=="admin")
    {
      return res.status(403).json({
        error:"Admin only"
      })
    }
    const snapshot = await db
      .collection("withdrawal_requests")
      .orderBy("createdAt", "desc")
      .get();

    const data = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/withdrawals/pending", authenticate, async (req, res) => {
  try {
        if(req.user.role !=="admin")
    {
      return res.status(403).json({
        error:"Admin only"
      })
    }
    const snapshot = await db
      .collection("withdrawal_requests")
      .where("status", "==", "pending")
      .orderBy("createdAt", "desc")
      .get();

    const data = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/admin/approve-withdrawal", authenticate, async (req, res) => {
  const { requestId } = req.body;

  try {
        if(req.user.role !=="admin")
    {
      return res.status(403).json({
        error:"Admin only"
      })
    }
    const reqRef = db.collection("withdrawal_requests").doc(requestId);
  

    await db.runTransaction(async (t) => {
      const reqDoc = await t.get(reqRef);

      if (!reqDoc.exists) {
        throw new Error("Request not found");
      }

      const request = reqDoc.data();

      if (request.status !== "pending") {
        throw new Error("Already processed");
      }
      const userRef=db.collection("users").doc(request.userId);
      const userDoc=await t.get(userRef);
      const existingUpi = userDoc.exists ? userDoc.data().upiId : null;
      

      // ✅ Update request
      t.update(reqRef, {
        status: "approved",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (!existingUpi) {
  t.set(userRef, {
    upiId: request.upiId,
    upiVerified: true,
    upiUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}else if (existingUpi === request.upiId) {
  // keep as is
}
else {
  t.set(userRef, {
    upiId: request.upiId,
    upiVerified: true, // ✅ because admin just approved THIS UPI
    upiUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

      // 🧾 Optional: transaction log (admin payout)
      const txRef = db.collection("wallet_transactions").doc();
      t.set(txRef, {
        id: txRef.id,
        userId: request.userId,
        type: "debit",
        amount: request.amount,
        source: "withdrawal_approved",
        referenceId: requestId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ success: true });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
const allowedReasons = [
  "Invalid UPI ID",
  "UPI not linked",
  "KYC not completed",
  "Suspicious activity"
];

app.post("/admin/reject-withdrawal", authenticate, async (req, res) => {
  const { requestId, reason } = req.body;
      if(req.user.role !=="admin")
    {
      return res.status(403).json({
        error:"Admin only"
      })
    }

  if (!reason || !allowedReasons.includes(reason)) {
    return res.status(400).json({
      error: "Invalid rejection reason",
      allowedReasons
    });
  }

  try {
    const reqRef = db.collection("withdrawal_requests").doc(requestId);

    await db.runTransaction(async (t) => {
      const reqDoc = await t.get(reqRef);

      if (!reqDoc.exists) {
        throw new Error("Request not found");
      }

      const request = reqDoc.data();

      if (request.status !== "pending") {
        throw new Error("Already processed");
      }

      // 🔹 Update request with reason
      t.update(reqRef, {
        status: "rejected",
        rejectionReason: reason,
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 🔁 Refund wallet
      const walletRef = db.collection("wallets").doc(request.userId);
      const walletDoc = await t.get(walletRef);

      const balance = walletDoc.exists ? walletDoc.data().balance : 0;

      t.set(walletRef, {
        userId: request.userId,
        balance: balance + request.amount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // 🧾 Wallet transaction
      const txRef = db.collection("wallet_transactions").doc();
      t.set(txRef, {
        id: txRef.id,
        userId: request.userId,
        type: "refund",
        amount: request.amount,
        source: "withdrawal_rejected",
        referenceId: requestId,
        note: reason,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ success: true });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});



// ========== START SERVER ==========


// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
