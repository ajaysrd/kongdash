/**
 * Copyright (c) Ajay Sreedhar. All rights reserved.
 *
 * Licensed under the MIT License.
 * Please see LICENSE file located in the project root for more information.
 */

'use strict';

import {isText, isEmpty, isNil, deepClone} from '../../lib/core-toolkit.js';
import {editViewURL, simplifyObjectId, tagsToText, urlOffset, urlQuery} from '../helpers/rest-toolkit.js';
import {epochToDate} from '../helpers/date-lib.js';

import serviceModel from '../models/service-model.js';

/**
 * Holds the list of available protocols and their configuration,
 *
 * The configuration also specifies the array of fields to be removed from
 * the service object payload to avoid validation errors.
 *
 * @type {{
 *      tcp: {excluded: string[]}, udp: {excluded: string[]},
 *      tls_passthrough: {excluded: string[]}, http: {excluded: string[]},
 *      tls: {excluded: string[]}, https: {excluded: *[]}, grpc: {excluded: string[]}
 * }}
 */
const ENUM_PROTOCOL = {
    http: {excluded: ['ca_certificates', 'tls_verify', 'tls_verify_depth']},
    https: {excluded: []},
    grpc: {excluded: ['ca_certificates', 'tls_verify', 'tls_verify_depth', 'path']},
    tcp: {excluded: ['ca_certificates', 'tls_verify', 'tls_verify_depth', 'path']},
    udp: {excluded: ['ca_certificates', 'tls_verify', 'tls_verify_depth', 'path']},
    tls: {excluded: ['ca_certificates', 'tls_verify', 'tls_verify_depth', 'path']},
    tls_passthrough: {excluded: ['ca_certificates', 'tls_verify', 'tls_verify_depth']}
};

/**
 * Populates service model after sanitising values in the service object.
 *
 * @see https://docs.konghq.com/gateway/2.7.x/admin-api/#service-object
 *
 * @param {ServiceModel} model - A service model object.
 * @param {Object} source - A service object.
 * @return {ServiceModel} The populated service model.
 */
function refreshServiceModel(model, source = {}) {
    const fieldList = Object.keys(source);

    for (let field of fieldList) {
        if (isNil(model[field]) || isNil(source[field])) continue;

        switch (field) {
            case 'tls_verify':
                model[field] = source[field] === null ? 'default' : String(source[field]);
                break;

            case 'tls_verify_depth':
                model[field] = source[field] === null ? -1 : source[field];
                break;

            case 'client_certificate':
                model[field] = isText(source[field]['id']) ? source[field]['id'] : '__none__';
                break;

            default:
                model[field] = source[field];
                break;
        }
    }

    return model;
}

/**
 * Prepares service object after sanitising values in a specified service model.
 *
 * Technically, this function does the inverse of {@link refreshServiceModel} function.
 * The function validates service model before preparing the payload. Throws an error
 * if the validation fails.
 *
 * @see https://docs.konghq.com/gateway/2.7.x/admin-api/#service-object
 *
 * @param {ServiceModel} model - The source service model
 * @return {Object} The prepared service object
 */
function prepareServiceObject(model) {
    if (model.host.length === 0) {
        throw new Error('Please provide a valid host.');
    }

    const payload = deepClone(model);
    const {excluded} = ENUM_PROTOCOL[payload.protocol];

    delete payload.client_certificate;

    if (model.client_certificate.length >= 10) {
        payload.client_certificate = {id: model.client_certificate};
    }

    switch (model.tls_verify) {
        case 'true':
        case 'false':
            payload.tls_verify = model.tls_verify === 'true';
            break;

        default:
            payload.tls_verify = null;
    }

    payload.tls_verify_depth = model.tls_verify_depth === -1 ? null : model.tls_verify_depth;

    if (Array.isArray(excluded)) {
        for (let field of excluded) {
            delete payload[field];
        }
    }

    return payload;
}

/**
 * Provides controller constructor for editing service objects.
 *
 * @constructor
 * @param {Object} scope - Injected scope object.
 * @param {Object} location - Injected Angular location service.
 * @param {function} location.path - Tells the current view path.
 * @param {Object} routeParams - Object containing route parameters.
 * @param {string} routeParams.serviceId - The service id in editing mode.
 * @param {string} routeParams.certId - The certificate id if
 *                                      redirected from certificate view.
 * @param {RESTClientFactory} restClient - Customised HTTP REST client factory.
 * @param {ViewFrameFactory} viewFrame - Factory for sharing UI details.
 * @param {ToastFactory} toast - Factory for displaying notifications.
 *
 * @property {string[]} scope.ENUM_PROTOCOL - An array of protocols from {@link ENUM_PROTOCOL}.
 * @property {string} scope.serviceId - Holds the service object id in edit mode.
 * @property {ServiceModel} scope.serviceModel - Holds the service model object.
 */
export default function ServiceEditController(scope, location, routeParams, restClient, viewFrame, toast) {
    const restConfig = {method: 'POST', endpoint: '/services'};
    const eventLocks = {submitServiceForm: false, togglePluginState: false};

    let loaderSteps = 2;

    scope.ENUM_PROTOCOL = Object.keys(ENUM_PROTOCOL);

    scope.serviceId = '__none__';
    scope.serviceModel = deepClone(serviceModel);

    scope.pbCertId = '__none__';
    scope.pbCertList = [];
    scope.caCertList = [];

    scope.routeList = [];
    scope.routeNext = {offset: ''};

    scope.pluginList = [];
    scope.pluginNext = {offset: ''};

    /**
     * Retrieves the public client certificates.
     *
     * @param {string} endpoint - The resource endpoint
     * @return boolean - True if request could be made, false otherwise
     */
    scope.fetchPublicCertificates = function (endpoint = '/certificates') {
        const request = restClient.get(endpoint);

        request.then(({data: response}) => {
            for (let current of response.data) {
                scope.pbCertList.push({
                    nodeValue: current.id,
                    displayText: simplifyObjectId(current.id) + ' - ' + tagsToText(current.tags, 64)
                });
            }
        });

        request.catch(() => {
            toast.error('Could not load public certificates.');
        });

        request.finally(() => {
            viewFrame.incrementLoader();
        });

        return true;
    };

    /**
     * Retrieves the CA certificates.
     *
     * @param {string} endpoint - The resource endpoint
     * @return boolean - True if request could be made, false otherwise
     */
    scope.fetchCACertificates = (endpoint = '/ca_certificates') => {
        const request = restClient.get(endpoint);

        request.then(({data: response}) => {
            const certificates = [];

            for (let current of response.data) {
                certificates.push({
                    nodeValue: current.id,
                    displayText: simplifyObjectId(current.id) + ' - ' + tagsToText(current.tags, 64)
                });

                scope.caCertList = certificates;
            }
        });

        request.catch(() => {
            toast.error('Could not load CA certificates.');
        });

        request.finally(() => {
            viewFrame.incrementLoader();
        });

        return true;
    };

    /**
     * Retrieves the routes associated with the current service.
     *
     * @param {string|object|null} filters - Filters to the Admin API endpoint.
     * @return boolean - True if request could be made, false otherwise
     */
    scope.fetchMappedRoutes = function (filters = null) {
        const request = restClient.get(`/services/${scope.serviceId}/routes` + urlQuery(filters));

        viewFrame.setLoaderSteps(1);

        request.then(({data: response}) => {
            scope.routeNext.offset = urlOffset(response.next);

            for (let route of response.data) {
                scope.routeList.push({
                    id: route.id,
                    displayText: isText(route.name) ? route.name : simplifyObjectId(route.id),
                    subTagsText: isEmpty(route.tags) ? epochToDate(route.created_at) : tagsToText(route.tags)
                });
            }

            delete response.data;
        });

        request.catch(() => {
            toast.error('Could not load routes under the service.');
        });

        request.finally(() => {
            viewFrame.incrementLoader();
        });

        return true;
    };

    /**
     * Retrieves the plugins applied on the current service.
     *
     * @param {string|object|null} filters - Filters to the Admin API endpoint.
     * @return boolean - True if request could be made, false otherwise
     */
    scope.fetchAppliedPlugins = function (filters = null) {
        const request = restClient.get(`/services/${scope.serviceId}/plugins` + urlQuery(filters));

        viewFrame.setLoaderSteps(1);

        request.then(({data: response}) => {
            scope.pluginNext.offset = urlOffset(response.next);

            for (let plugin of response.data) {
                scope.pluginList.push({
                    id: plugin.id,
                    displayText: plugin.name,
                    subTagsText: isEmpty(plugin.tags) ? epochToDate(plugin.created_at) : tagsToText(plugin.tags),
                    enabled: plugin.enabled
                });
            }
        });

        request.catch(() => {
            toast.error('Could not load applied plugins.');
        });

        request.finally(() => {
            viewFrame.incrementLoader();
        });

        return true;
    };

    /**
     * Submit changes made on the service form.
     *
     * The service object payload is prepared and POST or PATCH
     * requests are triggered create or edit mode respectively.
     *
     * @param {Object} event - The current event object.
     * @return {boolean} True if the request could be made, false otherwise
     */
    scope.submitServiceForm = function (event) {
        event.preventDefault();

        if (eventLocks.submitServiceForm === true) return false;

        Object.keys(scope.serviceModel).forEach((key) => {
            if (isText(scope.serviceModel[key])) scope.serviceModel[key] = scope.serviceModel[key].trim();
        });

        let payload = null;

        try {
            payload = prepareServiceObject(scope.serviceModel);
            eventLocks.submitServiceForm = true;

            viewFrame.setLoaderSteps(1);
        } catch (error) {
            toast.error(error.message);
            return false;
        }

        const request = restClient.request({method: restConfig.method, endpoint: restConfig.endpoint, payload});

        request.then(({data: response}) => {
            toast.success('Service details saved successfully.');

            if (scope.serviceId === '__none__') window.location.href = editViewURL(location.path(), response.id);
        });

        request.catch(() => {
            toast.error('Unable to save service details.');
        });

        request.finally(() => {
            eventLocks.submitServiceForm = false;
            viewFrame.incrementLoader();
        });

        return true;
    };

    /**
     * Handles form reset event.
     *
     * Displays confirmation dialog before clearing the form.
     *
     * @param {Object} event - The current event object
     * @return boolean - True if reset confirmed, false otherwise
     */
    scope.resetServiceForm = function (event) {
        event.preventDefault();

        if (eventLocks.submitServiceForm === true) return false;

        const proceed = confirm('Proceed to clear the form?');
        if (proceed) scope.serviceModel = deepClone(serviceModel);

        return proceed;
    };

    /**
     * Toggles plugin state to enabled or disabled.
     *
     * The event listener is attached to plugin list table.
     *
     * @param {HTMLInputElement} target - The target checkbox element.
     * @returns {boolean} True if action completed, false otherwise.
     */
    scope.togglePluginState = function ({target}) {
        if (target.nodeName !== 'INPUT' || target.type !== 'checkbox' || eventLocks.togglePluginState === true) {
            return false;
        }

        eventLocks.togglePluginState = true;
        viewFrame.setLoaderSteps(1);

        const endpoint = `/services/${scope.serviceId}/plugins/${target.value}`;
        const request = restClient.patch(endpoint, {enabled: target.checked});

        request.then(() => {
            toast.success('Plugin ' + (target.checked ? 'enabled.' : 'disabled.'));
        });

        request.catch(() => {
            toast.error('Unable to change plugin state.');
        });

        request.finally(() => {
            eventLocks.togglePluginState = false;
            viewFrame.incrementLoader();
        });

        return true;
    };

    if (isText(routeParams.certId)) {
        restConfig.endpoint = `/certificates/${routeParams.certId}${restConfig.endpoint}`;

        scope.pbCertId = routeParams.certId;
        scope.serviceModel.client_certificate = routeParams.certId;
    } else {
        scope.fetchPublicCertificates();
        viewFrame.clearBreadcrumbs();
    }

    viewFrame.addBreadcrumb('#!/services', 'Services');

    switch (routeParams.serviceId) {
        case '__create__':
            viewFrame.setTitle('Create Service');
            viewFrame.addBreadcrumb(location.path(), 'Create +');
            break;

        default:
            restConfig.method = 'PATCH';
            restConfig.endpoint = `${restConfig.endpoint}/${routeParams.serviceId}`;

            scope.serviceId = routeParams.serviceId;
            viewFrame.setTitle('Edit Service');
            loaderSteps = 5;
            break;
    }

    viewFrame.setLoaderSteps(loaderSteps);

    if (restConfig.method === 'PATCH' && scope.serviceId !== '__none__') {
        const request = restClient.get(restConfig.endpoint);

        request.then(({data: response}) => {
            const {id, name} = response;
            refreshServiceModel(scope.serviceModel, response);

            viewFrame.addBreadcrumb(`#!/services/${id}`, isText(name) ? name : simplifyObjectId(id));
            viewFrame.addAction('Delete', '#!/services', 'critical delete', 'service', restConfig.endpoint);
        });

        request.catch(() => {
            viewFrame.resetLoader();
            toast.error('Could not load service details');

            window.location.href = '#!/services';
        });

        request.finally(() => {
            viewFrame.incrementLoader();
        });

        scope.fetchMappedRoutes();
        scope.fetchAppliedPlugins();
    }

    scope.fetchCACertificates();
}
