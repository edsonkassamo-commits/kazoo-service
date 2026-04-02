// ══════════════════════════════════════════════
// ROUTES: /api/v1/bookings
// ══════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/bookingController');
const { authenticate, isProvider, isCustomer } = require('../middleware/auth');

router.use(authenticate); // All booking routes require auth

router.post('/',                   ctrl.create);
router.get('/',                    ctrl.list);
router.get('/:id',                 ctrl.getOne);
router.get('/:id/receipt',         ctrl.getReceipt);
router.put('/:id/accept',          isProvider, ctrl.accept);
router.put('/:id/reject',          isProvider, ctrl.reject);
router.put('/:id/start',           isProvider, ctrl.start);
router.put('/:id/complete',        isProvider, ctrl.complete);
router.put('/:id/cancel',          ctrl.cancel);
router.post('/:id/dispute',        ctrl.dispute);

module.exports = router;

// ══════════════════════════════════════════════
// CONTROLLER: bookingController.js
// ══════════════════════════════════════════════
// (Exported as a separate file below in reality
//  — combined here for readability)
