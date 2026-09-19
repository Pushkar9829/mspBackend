import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

const router = Router();
router.use(authenticate);

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.json(await service.getLedgerForUser(req.user._id, req.user.tenantId));
  })
);

export default router;
