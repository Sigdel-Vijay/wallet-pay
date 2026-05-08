import express from "express";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.json());

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
// 🔥 MAIN PAYMENT ROUTE
// ==========================
app.post("/pay", async (req, res) => {
    try {
        const {
            idToken,
            walletId,
            mpin,
            amount,
            purpose,
            remarks,
            clientTxnId
        } = req.body;

        if (!idToken || !walletId || !mpin || !amount) {
            return res.status(400).json({
                status: "FAILED",
                error: "Missing required fields"
            });
        }

        // ==========================
        // 🔥 VERIFY FIREBASE USER
        // ==========================
        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        // ==========================
        // 🔥 GET USER DATA
        // ==========================
        const userRef = db.ref(`wallets/${uid}`);
        const snapshot = await userRef.once("value");

        if (!snapshot.exists()) {
            return res.status(404).json({
                status: "FAILED",
                error: "Wallet not found"
            });
        }

        const userData = snapshot.val();

        const currentBalance = userData.balance || 0;
        const storedHashedMpin = userData.mpin; // bcrypt hash

        // ==========================
        // 🔥 VERIFY MPIN (bcrypt)
        // ==========================
        const isMpinValid = await bcrypt.compare(mpin, storedHashedMpin);

        if (!isMpinValid) {
            return res.status(401).json({
                status: "FAILED",
                error: "Invalid MPIN"
            });
        }

        const paymentAmount = parseInt(amount);

        // ==========================
        // 🔥 VALIDATION
        // ==========================
        if (paymentAmount <= 0) {
            return res.status(400).json({
                status: "FAILED",
                error: "Invalid amount"
            });
        }

        if (currentBalance < paymentAmount) {
            return res.status(400).json({
                status: "FAILED",
                error: "Insufficient balance"
            });
        }

        if (walletId === userData.walletId) {
            return res.status(400).json({
                status: "FAILED",
                error: "Cannot send money to yourself"
            });
        }

        // ==========================
        // 🔥 TRANSACTION ID
        // ==========================
        const transactionId = uuidv4();

        // ==========================
        // 🔥 UPDATE BALANCE (ATOMIC STYLE)
        // ==========================
        const newBalance = currentBalance - paymentAmount;

        await userRef.update({
            balance: newBalance
        });

        // ==========================
        // 🔥 SAVE TRANSACTION
        // ==========================
        await db.ref(`transactions/${transactionId}`).set({
            transactionId,
            from: uid,
            to: walletId,
            amount: paymentAmount,
            purpose: purpose || "",
            remarks: remarks || "",
            status: "SUCCESS",
            createdAt: Date.now(),
            clientTxnId: clientTxnId || null
        });

        // ==========================
        // 🔥 OPTIONAL: CREDIT RECEIVER
        // ==========================
        const receiverSnap = await db.ref(`wallets`).orderByChild("walletId").equalTo(walletId).once("value");

        receiverSnap.forEach(child => {
            const key = child.key;
            const data = child.val();

            const updatedBalance = (data.balance || 0) + paymentAmount;

            db.ref(`wallets/${key}`).update({
                balance: updatedBalance
            });
        });

        // ==========================
        // 🔥 SUCCESS RESPONSE
        // ==========================
        return res.json({
            status: "SUCCESS",
            transactionId,
            message: "Payment successful"
        });

    } catch (error) {
        console.error("PAYMENT ERROR:", error);

        return res.status(500).json({
            status: "FAILED",
            error: "Internal server error"
        });
    }
});

// ==========================
// 🔥 START SERVER
// ==========================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});