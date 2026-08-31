import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

export const list = asyncHandler(async (req, res) => {
  res.json(await service.listUsers(req));
});

export const get = asyncHandler(async (req, res) => {
  res.json(await service.getUser(req, req.params.id));
});

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createUser(req, req.body));
});

export const update = asyncHandler(async (req, res) => {
  res.json(await service.updateUser(req, req.params.id, req.body));
});

export const remove = asyncHandler(async (req, res) => {
  res.json(await service.deleteUser(req, req.params.id));
});
