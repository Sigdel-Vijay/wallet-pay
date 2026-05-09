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

// =============================
// ✅ HELPER: SANITIZE DATA FOR FCM
// =============================
const toStringData = (obj) => {
  const result = {};
  for (const key in obj) {
    result[key] = String(obj[key] ?? "");
  }
  return result;
};

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

  const {
    idToken,
    walletId,
    type,
    mpin,
    amount,
    purpose,
    remarks,
    clientTxnId,
  } = req.body;

  try {
    if (type !== null && type === "user") {
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

      // 🔥 GET SENDER (FIXED)
      const senderRef = db.ref(`wallets/${uid}`);
      const senderSnap = await senderRef.get();

      if (!senderSnap.exists()) {
        throw new Error("Sender not found");
      }

      const senderData = senderSnap.val();

      if (!senderData) {
        throw new Error("Sender data missing");
      }

      const storedHashedMpin = senderData.mpinHash;
      const senderWalletId = senderData.walletId;

      const senderAvailableBalance = Number(senderData.balance) || 0;

      // 🔥 SAFETY CHECK (IMPORTANT)
      if (!storedHashedMpin) {
        throw new Error("MPIN not set for this user");
      }

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
      let receiverData = null;

      receiverSnap.forEach((snap) => {
        receiverKey = snap.key;
        receiverData = snap.val();
      });

      if (!receiverKey) {
        throw new Error("Receiver lookup failed");
      }

      const receiverRef = db.ref(`wallets/${receiverKey}`);

      // ==========================
      // 🔥 DUPLICATE TXN PROTECTION
      // ==========================
      if (clientTxnId) {
        const txnLockRef = db.ref(`transactions/${clientTxnId}`);

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
        if (!data) throw new Error("Sender not found");

        const balance = Number(data.balance);

        if (isNaN(balance)) throw new Error("Invalid balance");

        if (balance < payAmount) {
          throw new Error("Insufficient balance");
        }

        data.balance = balance - payAmount;
        return data;
      });

      if (!debitResult.committed) {
        throw new Error("Debit failed, transaction aborted");
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

      const txData = {
        id: clientTxnId,
        from: senderWalletId,
        to: walletId,
        amount: payAmount,
        purpose: purpose || "",
        remarks: remarks || "",
        status: "SUCCESS",
        createdAt: admin.database.ServerValue.TIMESTAMP,
        clientTxnId: clientTxnId || null,
        notificationSent: false,
      };

      let transactionRef = db.ref(`transactions/${clientTxnId}`);

      await transactionRef.set(txData);

      paymentCompleted = true;

      // ==========================
      //  🔔 SEND NOTIFICATION
      // ==========================

      const txSnap = await transactionRef.get();
      const tx = txSnap.val();

      if (tx.status === "SUCCESS" && !tx.notificationSent) {
        const senderTokensSnap = await db.ref(`fcmTokens/users/${uid}`).get();
        const receiverTokensSnap = await db
          .ref(`fcmTokens/users/${receiverKey}`)
          .get();

        let senderTokens = [];

        let receiverTokens = [];

        if (receiverTokensSnap.exists()) {
          const tokensObj = receiverTokensSnap.val();
          receiverTokens = Object.keys(tokensObj);
        }

        const tasks = [];

        if (senderTokensSnap.exists()) {
          const tokensObj = senderTokensSnap.val();
          senderTokens = Object.keys(tokensObj);
        }

        if (senderTokens.length > 0) {
          tasks.push({
            type: "sender",
            tokens: senderTokens,
            promise: admin.messaging().sendEachForMulticast({
              tokens: senderTokens,
              data: toStringData({
                title: "Payment Successful",
                body: `Paid NPR ${payAmount.toFixed(2)} to ${receiverData.walletId}`,
                type: "payment",
                amount: payAmount.toFixed(2),
                senderName: senderData.name,
                receiverName: receiverData.name,
                transactionType: "sent",
                transactionId: clientTxnId,
              }),
            }),
          });
        }

        if (receiverTokens.length > 0) {
          tasks.push({
            type: "receiver",
            tokens: receiverTokens,
            promise: admin.messaging().sendEachForMulticast({
              tokens: receiverTokens,
              data: toStringData({
                title: "Payment Received",
                body: `Received NPR ${payAmount.toFixed(2)} from ${senderData.walletId}`,
                type: "payment",
                amount: payAmount.toFixed(2),
                senderName: senderData.name,
                receiverName: receiverData.name,
                transactionType: "received",
                transactionId: clientTxnId,
              }),
            }),
          });
        }

        try {
          const results = await Promise.all(tasks.map((t) => t.promise));

          // cleanup
          results.forEach((res, i) => {
            const { type, tokens } = tasks[i];

            res.responses.forEach((r, idx) => {
              if (!r.success) {
                const badToken = tokens[idx];

                if (type === "sender") {
                  db.ref(`fcmTokens/users/${uid}/${badToken}`).remove();
                } else {
                  db.ref(`fcmTokens/users/${receiverKey}/${badToken}`).remove();
                }
              }
            });
          });

          await transactionRef.update({ notificationSent: true });
        } catch (err) {
          console.error("Notification failed:", err);

          await transactionRef.update({
            notificationError: err.message,
          });
        }
      }

      // ==========================
      // 🔥 SUCCESS RESPONSE
      // ==========================
      return res.json({
        status: "SUCCESS",
        clientTxnId: clientTxnId,
        message: "Payment successful",
      });

    } else if (type !== null && type === "merchant") {
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

      // 🔥 GET SENDER (FIXED)
      const senderRef = db.ref(`wallets/${uid}`);
      const senderSnap = await senderRef.get();

      if (!senderSnap.exists()) {
        throw new Error("Sender not found");
      }

      const senderData = senderSnap.val();

      if (!senderData) {
        throw new Error("Sender data missing");
      }

      const storedHashedMpin = senderData.mpinHash;
      const senderWalletId = senderData.walletId;

      const senderAvailableBalance = Number(senderData.balance) || 0;

      // 🔥 SAFETY CHECK (IMPORTANT)
      if (!storedHashedMpin) {
        throw new Error("MPIN not set for this user");
      }

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
        .ref("merchants")
        .orderByChild("merchantId")
        .equalTo(walletId)
        .get();

      if (!receiverSnap.exists()) {
        throw new Error("Receiver not found");
      }

      let receiverKey = null;
      let receiverData = null;
      let receiverUid = null;

      receiverSnap.forEach((snap) => {
        receiverKey = snap.key;
        receiverData = snap.val();
        receiverUid = snap.val().uid; // Assuming the merchant data contains a uid field
      });

      if (!receiverKey) {
        throw new Error("Receiver lookup failed");
      }

      const receiverRef = db.ref(`merchants/${walletId}`);

      // ==========================
      // 🔥 DUPLICATE TXN PROTECTION
      // ==========================
      if (clientTxnId) {
        const txnLockRef = db.ref(`transactions/${clientTxnId}`);

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
        if (!data) throw new Error("Sender not found");

        const balance = Number(data.balance);

        if (isNaN(balance)) throw new Error("Invalid balance");

        if (balance < payAmount) {
          throw new Error("Insufficient balance");
        }

        data.balance = balance - payAmount;
        return data;
      });

      if (!debitResult.committed) {
        throw new Error("Debit failed, transaction aborted");
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

      const txData = {
        id: clientTxnId,
        from: senderWalletId,
        to: walletId,
        amount: payAmount,
        purpose: purpose || "",
        remarks: remarks || "",
        status: "SUCCESS",
        createdAt: admin.database.ServerValue.TIMESTAMP,
        clientTxnId: clientTxnId || null,
        notificationSent: false,
      };

      let transactionRef = db.ref(`transactions/${clientTxnId}`);

      await transactionRef.set(txData);

      paymentCompleted = true;

      // ==========================
      //  🔔 SEND NOTIFICATION
      // ==========================

      const txSnap = await transactionRef.get();
      const tx = txSnap.val();

      if (tx.status === "SUCCESS" && !tx.notificationSent) {
        const senderTokensSnap = await db.ref(`fcmTokens/users/${uid}`).get();
        const receiverTokensSnap = await db
          .ref(`fcmTokens/merchants/${receiverUid}`)
          .get();

        let senderTokens = [];

        let receiverTokens = [];

        if (receiverTokensSnap.exists()) {
          const tokensObj = receiverTokensSnap.val();
          receiverTokens = Object.keys(tokensObj);
        }

        const tasks = [];

        if (senderTokensSnap.exists()) {
          const tokensObj = senderTokensSnap.val();
          senderTokens = Object.keys(tokensObj);
        }

        if (senderTokens.length > 0) {
          tasks.push({
            type: "sender",
            tokens: senderTokens,
            promise: admin.messaging().sendEachForMulticast({
              tokens: senderTokens,
              data: toStringData({
                title: "Payment Successful",
                body: `Paid NPR ${payAmount.toFixed(2)} to ${receiverData.merchantId}`,
                type: "payment",
                amount: payAmount.toFixed(2),
                senderName: senderData.name,
                receiverName: receiverData.businessName,
                transactionType: "sent",
                transactionId: clientTxnId,
              }),
            }),
          });
        }

        if (receiverTokens.length > 0) {
          tasks.push({
            type: "receiver",
            tokens: receiverTokens,
            promise: admin.messaging().sendEachForMulticast({
              tokens: receiverTokens,
              data: toStringData({
                title: "Payment Received",
                body: `Received NPR ${payAmount.toFixed(2)} from ${senderData.walletId}`,
                type: "payment",
                amount: payAmount.toFixed(2),
                senderName: senderData.name,
                receiverName: receiverData.businessName,
                transactionType: "received",
                transactionId: clientTxnId,
              }),
            }),
          });
        }

        try {
          const results = await Promise.all(tasks.map((t) => t.promise));

          // cleanup
          results.forEach((res, i) => {
            const { type, tokens } = tasks[i];

            res.responses.forEach((r, idx) => {
              if (!r.success) {
                const badToken = tokens[idx];

                if (type === "sender") {
                  db.ref(`fcmTokens/users/${uid}/${badToken}`).remove();
                } else {
                  db.ref(`fcmTokens/merchants/${receiverKey}/${badToken}`).remove();
                }
              }
            });
          });

          await transactionRef.update({ notificationSent: true });
        } catch (err) {
          console.error("Notification failed:", err);

          await transactionRef.update({
            notificationError: err.message,
          });
        }
      }

      // ==========================
      // 🔥 SUCCESS RESPONSE
      // ==========================
      return res.json({
        status: "SUCCESS",
        clientTxnId: clientTxnId,
        message: "Payment successful",
      });
    }
  } catch (error) {
    console.error("PAYMENT ERROR:", error);

    // ==========================
    // 🔥 REMOVE TXN LOCK ON FAILURE
    // ==========================
    try {
      if (!paymentCompleted && clientTxnId) {
        await db.ref(`transactions/${clientTxnId}`).remove();
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
