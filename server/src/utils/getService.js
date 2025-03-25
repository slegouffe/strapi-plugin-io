'use strict';

import { pluginId } from './pluginId';

const getService = ({ name, plugin = pluginId, type = 'plugin' }) => {
	let serviceUID = `${type}::${plugin}`;

	if (name && name.length) {
		serviceUID += `.${name}`;
	}

	return strapi.service(serviceUID);
}

export { getService };