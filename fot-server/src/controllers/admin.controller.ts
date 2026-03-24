import { adminUsersController } from './admin-users.controller.js';
import { adminOrgController } from './admin-org.controller.js';
import { admin2faController } from './admin-2fa.controller.js';

export const adminController = {
  ...adminUsersController,
  ...adminOrgController,
  ...admin2faController,
};
