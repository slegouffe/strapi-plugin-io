'use strict';

export default ({ strapi }) => {
	/**
	 * Sanitize data output with a provided schema for a specified role
	 *
	 * @param {Object} param
	 * @param {Object} param.schema
	 * @param {Object} param.data
	 * @param {Object} param.auth
	 */
	const output = async ({ schema, data, options }) => {
		return await strapi.contentAPI.sanitize.output(data, schema, options);
	}

	return {
		output,
	};
};