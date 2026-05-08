import express from "express";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================
// 🔥 MIDDLEWARE
// ==========================
app.use(bodyParser.json());
app.use(express.json());

app.use((req, res, next) => {
  res.setTimeout(30000);
  next();
});

// ==========================
// 🔥 FIREBASE INIT
// ==========================
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

// ==========================
// 🔥 HEALTH CHECK
// ==========================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "Wallet payment server running",
  });
});

// ==========================
// 🔥 MAIN PAYMENT ROUTE
// ==========================
app.post("/pay", async (req, res) => {
  let paymentCompleted = false;

  const { idToken, walletId, mpin, amount, purpose, remarks, clientTxnId } =
    req.body;

  try {
    // ==========================
    // 🔥 VALIDATE INPUT
    // ==========================
    if (!idToken || !walletId || !mpin || !amount) {
      return res.status(400).json({
        status: "FAILED",
        error: "Missing required fields",
      });
    }

    const payAmount = parseFloat(amount);

    if (isNaN(payAmount) || payAmount <= 0) {
      throw new Error("Invalid amount");
    }

    // ==========================
    // 🔥 VERIFY FIREBASE TOKEN
    // ==========================
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // ==========================
    // 🔥 GET SENDER
    // ==========================
    const senderRef = db.ref(`wallets/${uid}`);
    const senderSnap = await senderRef.get();

    if (!senderSnap.exists()) {
      throw new Error("Sender not found");
    }

    const senderData = senderSnap.val();

    const senderWalletId = senderData.walletId;
    const storedHashedMpin = senderData.mpinHash;

    // ==========================
    // 🔥 PREVENT SELF TRANSFER
    // ==========================
    if (walletId === senderWalletId) {
      throw new Error("Cannot send money to yourself");
    }

    // ==========================
    // 🔥 VERIFY MPIN
    // ==========================
    const isMpinValid = await bcrypt.compare(mpin, storedHashedMpin);

    if (!isMpinValid) {
      throw new Error("Invalid MPIN");
    }

    // ==========================
    // 🔥 GET RECEIVER
    // ==========================
    const receiverSnap = await db
      .ref("wallets")
      .orderByChild("walletId")
      .equalTo(walletId)
      .get();

    if (!receiverSnap.exists()) {
      throw new Error("Receiver not found");
    }

    let receiverKey = null;

    receiverSnap.forEach((snap) => {
      receiverKey = snap.key;
    });

    if (!receiverKey) {
      throw new Error("Receiver lookup failed");
    }

    const receiverRef = db.ref(`wallets/${receiverKey}`);

    // ==========================
    // 🔥 DUPLICATE TXN PROTECTION
    // ==========================
    if (clientTxnId) {
      const txnLockRef = db.ref(`clientTransactions/${clientTxnId}`);

      const txnLock = await txnLockRef.transaction((data) => {
        if (data) {
          return;
        }

        return {
          createdAt: admin.database.ServerValue.TIMESTAMP,
        };
      });

      if (!txnLock.committed) {
        return res.json({
          status: "SUCCESS",
          message: "Already processed",
        });
      }
    }

    // ==========================
    // 🔥 DEBIT SENDER
    // ==========================
    const debitResult = await senderRef.transaction((data) => {
      if (!data) return;

      const balance = data.balance || 0;

      if (balance < payAmount) {
        return;
      }

      data.balance = balance - payAmount;

      return data;
    });

    if (!debitResult.committed) {
      throw new Error("Insufficient balance");
    }

    // ==========================
    // 🔥 CREDIT RECEIVER
    // ==========================
    try {
      await receiverRef.transaction((data) => {
        if (!data) {
          return {
            balance: payAmount,
          };
        }

        data.balance = (data.balance || 0) + payAmount;

        return data;
      });
    } catch (creditError) {
      // ==========================
      // 🔥 ROLLBACK SENDER
      // ==========================
      await senderRef.transaction((data) => {
        if (!data) return data;

        data.balance = (data.balance || 0) + payAmount;

        return data;
      });

      throw new Error("Receiver credit failed");
    }

    // ==========================
    // 🔥 SAVE TRANSACTION
    // ==========================
    const transactionId = uuidv4();

    const txData = {
      transactionId,
      from: senderWalletId,
      to: walletId,
      amount: payAmount,
      purpose: purpose || "",
      remarks: remarks || "",
      status: "SUCCESS",
      createdAt: admin.database.ServerValue.TIMESTAMP,
      clientTxnId: clientTxnId || null,
    };

    await db.ref(`transactions/${transactionId}`).set(txData);

    paymentCompleted = true;

    // ==========================
    // 🔥 SUCCESS RESPONSE
    // ==========================
    return res.json({
      status: "SUCCESS",
      transactionId,
      message: "Payment successful",
    });
  } catch (error) {
    console.error("PAYMENT ERROR:", error);

    // ==========================
    // 🔥 REMOVE TXN LOCK ON FAILURE
    // ==========================
    try {
      if (!paymentCompleted && clientTxnId) {
        await db.ref(`clientTransactions/${clientTxnId}`).remove();
      }
    } catch (lockError) {
      console.error("LOCK CLEANUP ERROR:", lockError);
    }

    return res.status(400).json({
      status: "FAILED",
      error: error.message || "Internal server error",
    });
  }
});

// ==========================
// 🔥 404 HANDLER
// ==========================
app.use((req, res) => {
  return res.status(404).json({
    status: "FAILED",
    error: "Route not found",
  });
});

// ==========================
// 🔥 GLOBAL ERROR HANDLER
// ==========================
app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);

  return res.status(500).json({
    status: "FAILED",
    error: "Internal server error",
  });
});

// ==========================
// 🔥 START SERVER
// ==========================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
