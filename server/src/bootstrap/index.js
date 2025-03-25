import { bootstrapIO } from './io';
import { bootstrapLifecycles } from './lifecycle';

const bootstrap = ({ strapi }) => {
  // bootstrap phase
  console.log('\n IO Bootstrap !');
  bootstrapIO({ strapi });
  bootstrapLifecycles({ strapi });
};

export default bootstrap;
