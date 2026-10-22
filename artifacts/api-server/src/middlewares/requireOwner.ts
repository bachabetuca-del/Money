import { clerkClient, getAuth } from "@clerk/express";
import type { RequestHandler } from "express";
import { isOwner } from "../lib/owner-policy";

// Authorization is server-side and uses Clerk's verified email, never client metadata.
export const requireOwner: RequestHandler = async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to manage this bot." });
    return;
  }
  if (!process.env.OWNER_EMAIL?.trim()) {
    res.status(503).json({ error: "Owner access has not been configured." });
    return;
  }
  try {
    const user = await clerkClient.users.getUser(userId);
    if (!isOwner(user, process.env.OWNER_EMAIL)) {
      res.status(403).json({ error: "This dashboard is restricted to its owner. Sign in with the owner's verified email." });
      return;
    }
    next();
  } catch {
    req.log.warn("Unable to verify dashboard owner");
    res.status(503).json({ error: "Could not verify owner access. Please retry." });
  }
};
