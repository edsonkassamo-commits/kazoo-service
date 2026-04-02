const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

// Public routes
router.post('/register',        ctrl.register);
router.post('/login',           ctrl.login);
router.post('/send-otp',        ctrl.sendOtp);
router.post('/verify-otp',      ctrl.verifyOtp);
router.post('/refresh',         ctrl.refresh);
router.post('/forgot-password', ctrl.forgotPassword);
router.post('/reset-password',  ctrl.resetPassword);

// Protected routes
router.post('/logout', authenticate, ctrl.logout);

module.exports = router;
