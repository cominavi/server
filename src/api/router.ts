import { authRouter } from "./auth";
import { catalogsRouter } from "./routers/catalogs";
import { catalogControlRouter } from "./routers/catalog-control";
import { crawlerIngressRouter } from "./routers/crawler-ingress";
import { favoritesRouter } from "./routers/favorites";
import { identityAvatarImportRouter } from "./routers/identity-avatar-import";
import { notificationRouter } from "./routers/notifications";
import { invitationRouter, plansRouter } from "./routers/plans-control";
import { profileRouter } from "./routers/profile";
import { pushDeviceRouter } from "./routers/push-devices";
import { realtimeUpdatesRouter } from "./routers/realtime-updates";
import { tagOverlayRouter } from "./routers/tag-overlays";

export const apiRouter = {
  auth: authRouter,
  catalogs: catalogsRouter,
  invitations: invitationRouter,
  imports: {
    xFollowings: identityAvatarImportRouter.xFollowingImport,
  },
  internal: {
    catalog: catalogControlRouter,
    crawler: { ...crawlerIngressRouter, tagOverlays: tagOverlayRouter },
  },
  me: {
    profile: profileRouter,
    avatar: identityAvatarImportRouter.currentUserAvatar,
    circlemsIdentity: identityAvatarImportRouter.circlemsLink,
    favorites: favoritesRouter,
    notifications: notificationRouter,
    pushDevices: pushDeviceRouter,
  },
  plans: plansRouter,
  realtimeUpdates: realtimeUpdatesRouter,
  users: {
    avatar: identityAvatarImportRouter.userAvatar,
  },
};

export type APIRouter = typeof apiRouter;
