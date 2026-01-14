// backend/src/routes/changeRequests.js

const express = require("express");
const { authRequired } = require("../middleware/auth");
const { requireRoleAtLeast, requireAnyRole } = require("../middleware/rbac");

const ChangeRequest = require("../models/ChangeRequest");
const AuditLog = require("../models/AuditLog");

const Language = require("../models/Language");
const Category = require("../models/Category");
const Item = require("../models/Item");
const Ad = require("../models/Ad");
const User = require("../models/User");

const router = express.Router();

function modelFor(type) {
  switch (type) {
    case "language": return Language;
    case "category": return Category;
    case "item": return Item;
    case "ad": return Ad;
    case "user": return User;
    default: return null;
  }
}

async function audit(actorId, action, entityType, entityId, meta = {}) {
  await AuditLog.create({ actorId, action, entityType, entityId, meta });
}

// Editor+ can submit change requests
router.post("/", authRequired, requireRoleAtLeast("editor"), async (req, res) => {
  const { entityType, action, entityId, payload } = req.body || {};
  if (!entityType || !action) return res.status(400).json({ message: "Missing entityType/action" });

  const cr = await ChangeRequest.create({
    entityType,
    action,
    entityId: entityId || undefined,
    payload: payload || {},
    status: "pending",
    createdBy: req.user.id
  });

  await audit(req.user.id, "change_request_created", entityType, cr._id, { action, target: entityId || null });
  res.json({ changeRequest: cr });
});

// List: editor sees their own, admin/owner sees all
router.get("/", authRequired, requireRoleAtLeast("editor"), async (req, res) => {
  const filter = req.user.role === "editor" ? { createdBy: req.user.id } : {};
  const requests = await ChangeRequest.find(filter).sort({ createdAt: -1 }).limit(500);
  res.json({ requests });
});

// Approve: admin/owner
router.post("/:id/approve", authRequired, requireAnyRole(["admin", "owner"]), async (req, res) => {
  const cr = await ChangeRequest.findById(req.params.id);
  if (!cr) return res.status(404).json({ message: "Not found" });
  if (cr.status !== "pending") return res.status(400).json({ message: "Already reviewed" });

  const Model = modelFor(cr.entityType);
  if (!Model) return res.status(400).json({ message: "Unknown entityType" });

  let appliedEntityId = cr.entityId;

  if (cr.action === "create") {
    const doc = await Model.create(cr.payload);
    appliedEntityId = doc._id;
  } else if (cr.action === "update") {
    if (!cr.entityId) return res.status(400).json({ message: "Missing entityId" });
    await Model.findByIdAndUpdate(cr.entityId, { $set: cr.payload }, { new: true });
  } else if (cr.action === "delete") {
    if (!cr.entityId) return res.status(400).json({ message: "Missing entityId" });
    await Model.findByIdAndDelete(cr.entityId);
  } else {
    return res.status(400).json({ message: "Invalid action" });
  }

  cr.status = "approved";
  cr.reviewedBy = req.user.id;
  cr.reviewedAt = new Date();
  cr.reviewNote = req.body?.note || "";
  await cr.save();

  await audit(req.user.id, "change_request_approved", cr.entityType, cr._id, { appliedEntityId });
  res.json({ ok: true, changeRequest: cr, appliedEntityId });
});

// Reject: admin/owner
router.post("/:id/reject", authRequired, requireAnyRole(["admin", "owner"]), async (req, res) => {
  const cr = await ChangeRequest.findById(req.params.id);
  if (!cr) return res.status(404).json({ message: "Not found" });
  if (cr.status !== "pending") return res.status(400).json({ message: "Already reviewed" });

  cr.status = "rejected";
  cr.reviewedBy = req.user.id;
  cr.reviewedAt = new Date();
  cr.reviewNote = req.body?.note || "";
  await cr.save();

  await audit(req.user.id, "change_request_rejected", cr.entityType, cr._id, {});
  res.json({ ok: true, changeRequest: cr });
});

module.exports = router;
