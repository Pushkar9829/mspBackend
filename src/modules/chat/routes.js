import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { chatLimiter } from "../../middleware/rateLimits.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

const router = Router();
router.use(authenticate, resolveTenant, chatLimiter);

router.get("/macros", authorize("chat.view"), asyncHandler(async (req, res) => {
  res.json(await service.listMacros(req));
}));
router.post("/macros", authorize("chat.reply"), asyncHandler(async (req, res) => {
  res.status(201).json(await service.saveMacro(req, req.body));
}));

router.get("/", authorize("chat.view"), asyncHandler(async (req, res) => {
  res.json(await service.listConversations(req));
}));
router.post("/", authorize("chat.reply"), asyncHandler(async (req, res) => {
  res.status(201).json(await service.startConversation(req, req.body));
}));
router.get("/:id", authorize("chat.view"), asyncHandler(async (req, res) => {
  res.json(await service.getConversation(req, req.params.id));
}));
router.get("/:id/messages", authorize("chat.view"), asyncHandler(async (req, res) => {
  res.json(await service.listMessages(req, req.params.id));
}));
router.post("/:id/messages", authorize("chat.reply"), asyncHandler(async (req, res) => {
  res.status(201).json(await service.postMessage(req, req.params.id, req.body));
}));
router.post("/:id/assign", authorize("chat.assign"), asyncHandler(async (req, res) => {
  res.json(await service.assignConversation(req, req.params.id, req.body.assigneeId));
}));
router.post("/:id/close", authorize("chat.close"), asyncHandler(async (req, res) => {
  res.json(await service.closeConversation(req, req.params.id));
}));
router.post("/:id/escalate", authorize("chat.assign"), asyncHandler(async (req, res) => {
  res.json(await service.escalateConversation(req, req.params.id));
}));
router.post("/:id/read", authorize("chat.view"), asyncHandler(async (req, res) => {
  res.json(await service.markRead(req, req.params.id));
}));

export default router;
