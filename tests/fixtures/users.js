import { ROLES } from '../../src/modules/users/user.model.js';

/** Valid registration payloads the suites can spread and override. */
export const customerPayload = {
  name: 'Ada Customer',
  email: 'ada@example.com',
  password: 'Str0ngPassw0rd',
  role: ROLES.CUSTOMER,
};

export const sellerPayload = {
  name: 'Grace Seller',
  email: 'grace@example.com',
  password: 'Str0ngPassw0rd',
  role: ROLES.SELLER,
};

export const addressPayload = {
  fullName: 'Ada Customer',
  phone: '+15550100',
  line1: '1 Analytical Engine Way',
  city: 'London',
  state: 'Greater London',
  postalCode: 'EC1A 1BB',
  country: 'United Kingdom',
};
