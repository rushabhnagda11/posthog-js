/* eslint camelcase: "off" */
import Config from './config';
import { _, console, userAgent, window, document, navigator } from './utils';
import { autocapture } from './autocapture';
import { LinkCapture } from './dom-capture';
import { PostHogPeople } from './posthog-people';
import {
    PostHogPersistence,
    PEOPLE_DISTINCT_ID_KEY,
    ALIAS_ID_KEY
} from './posthog-persistence';
import {
    optIn,
    optOut,
    hasOptedIn,
    hasOptedOut,
    clearOptInOut,
    addOptOutCheckPostHogLib
} from './gdpr-utils';

// ==ClosureCompiler==
// @compilation_level ADVANCED_OPTIMIZATIONS
// @output_file_name posthog-2.8.min.js
// ==/ClosureCompiler==

/*
SIMPLE STYLE GUIDE:

this.x === public function
this._x === internal - only use within this file
this.__x === private - only use within the class

Globals should be all caps
*/

var init_type;       // MODULE or SNIPPET loader
var posthog_master; // main posthog instance / object
var INIT_MODULE  = 0;
var INIT_SNIPPET = 1;
// some globals for comparisons
var __NOOP = function () {}
var __NOOPTIONS = {}

/** @const */ var PRIMARY_INSTANCE_NAME = 'posthog';


/*
 * Dynamic... constants? Is that an oxymoron?
 */
// http://hacks.mozilla.org/2009/07/cross-site-xmlhttprequest-with-cors/
// https://developer.mozilla.org/en-US/docs/DOM/XMLHttpRequest#withCredentials
var USE_XHR = (window.XMLHttpRequest && 'withCredentials' in new XMLHttpRequest());

// IE<10 does not support cross-origin XHR's but script tags
// with defer won't block window.onload; ENQUEUE_REQUESTS
// should only be true for Opera<12
var ENQUEUE_REQUESTS = !USE_XHR && (userAgent.indexOf('MSIE') === -1) && (userAgent.indexOf('Mozilla') === -1);

// save reference to navigator.sendBeacon so it can be minified
var sendBeacon = window.navigator['sendBeacon'];
if (sendBeacon) {
    sendBeacon = _.bind(sendBeacon, navigator);
}

/*
 * Module-level globals
 */
var DEFAULT_CONFIG = {
    'api_host':                          'https://t.posthog.com',
    'api_method':                        'POST',
    'api_transport':                     'XHR',
    'autocapture':                         true,
    'cdn':                               'https://cdn.posthog.com',
    'cross_subdomain_cookie':            document.location.hostname.indexOf('herokuapp.com') === -1,
    'persistence':                       'cookie',
    'persistence_name':                  '',
    'cookie_name':                       '',
    'loaded':                            function() {},
    'store_google':                      true,
    'save_referrer':                     true,
    'test':                              false,
    'verbose':                           false,
    'img':                               false,
    'capture_pageview':                    true,
    'debug':                             false,
    'capture_links_timeout':               300,
    'cookie_expiration':                 365,
    'upgrade':                           false,
    'disable_persistence':               false,
    'disable_cookie':                    false,
    'secure_cookie':                     false,
    'ip':                                true,
    'opt_out_capturing_by_default':      false,
    'opt_out_persistence_by_default':    false,
    'opt_out_capturing_persistence_type': 'localStorage',
    'opt_out_capturing_cookie_prefix':   null,
    'property_blacklist':                [],
    'xhr_headers':                       {}, // { header: value, header2: value }
    'inapp_protocol':                    '//',
    'inapp_link_new_window':             false,
    'request_batching':                  true
};

var DOM_LOADED = false;

/**
 * PostHog Library Object
 * @constructor
 */
var PostHogLib = function() {};


/**
 * create_mplib(token:string, config:object, name:string)
 *
 * This function is used by the init method of PostHogLib objects
 * as well as the main initializer at the end of the JSLib (that
 * initializes document.posthog as well as any additional instances
 * declared before this file has loaded).
 */
var create_mplib = function(token, config, name) {
    var instance,
        target = (name === PRIMARY_INSTANCE_NAME) ? posthog_master : posthog_master[name];

    if (target && init_type === INIT_MODULE) {
        instance = target;
    } else {
        if (target && !_.isArray(target)) {
            console.error('You have already initialized ' + name);
            return;
        }
        instance = new PostHogLib();
    }

    instance._cached_groups = {}; // cache groups in a pool
    instance._user_decide_check_complete = false;
    instance._events_captureed_before_user_decide_check_complete = [];

    instance._init(token, config, name);

    instance['people'] = new PostHogPeople();
    instance['people']._init(instance);

    // if any instance on the page has debug = true, we set the
    // global debug to be true
    Config.DEBUG = Config.DEBUG || instance.get_config('debug');

    instance['__autocapture_enabled'] = instance.get_config('autocapture');
    if (instance.get_config('autocapture')) {
        var num_buckets = 100;
        var num_enabled_buckets = 100;
        if (!autocapture.enabledForProject(instance.get_config('token'), num_buckets, num_enabled_buckets)) {
            instance['__autocapture_enabled'] = false;
            console.log('Not in active bucket: disabling Automatic Event Collection.');
        } else if (!autocapture.isBrowserSupported()) {
            instance['__autocapture_enabled'] = false;
            console.log('Disabling Automatic Event Collection because this browser is not supported');
        } else {
            autocapture.init(instance);
        }
    }

    // if target is not defined, we called init after the lib already
    // loaded, so there won't be an array of things to execute
    if (!_.isUndefined(target) && _.isArray(target)) {
        // Crunch through the people queue first - we queue this data up &
        // flush on identify, so it's better to do all these operations first
        instance._execute_array.call(instance['people'], target['people']);
        instance._execute_array(target);
    }

    return instance;
};

// Initialization methods

/**
 * This function initializes a new instance of the PostHog capturing object.
 * All new instances are added to the main posthog object as sub properties (such as
 * posthog.library_name) and also returned by this function. To define a
 * second instance on the page, you would call:
 *
 *     posthog.init('new token', { your: 'config' }, 'library_name');
 *
 * and use it like so:
 *
 *     posthog.library_name.capture(...);
 *
 * @param {String} token   Your PostHog API token
 * @param {Object} [config]  A dictionary of config options to override. <a href="https://github.com/posthog/posthog-js/blob/8b2e1f7b/src/posthog-core.js#L87-L110">See a list of default config options</a>.
 * @param {String} [name]    The name for the new posthog instance that you want created
 */
PostHogLib.prototype.init = function (token, config, name) {
    if (_.isUndefined(name)) {
        console.error('You must name your new library: init(token, config, name)');
        return;
    }
    if (name === PRIMARY_INSTANCE_NAME) {
        console.error('You must initialize the main posthog object right after you include the PostHog js snippet');
        return;
    }

    var instance = create_mplib(token, config, name);
    posthog_master[name] = instance;
    instance._loaded();

    return instance;
};

// posthog._init(token:string, config:object, name:string)
//
// This function sets up the current instance of the posthog
// library.  The difference between this method and the init(...)
// method is this one initializes the actual instance, whereas the
// init(...) method sets up a new library and calls _init on it.
//
PostHogLib.prototype._init = function(token, config, name) {
    this['__loaded'] = true;
    this['config'] = {};
    this['_triggered_notifs'] = [];

    this.set_config(_.extend({}, DEFAULT_CONFIG, config, {
        'name': name,
        'token': token,
        'callback_fn': ((name === PRIMARY_INSTANCE_NAME) ? name : PRIMARY_INSTANCE_NAME + '.' + name) + '._jsc'
    }));

    this['_jsc'] = function() {};

    // batching requests variabls
    this._event_queue = []
    this._empty_queue_count = 0 // to track empty polls
    this._should_poll = true // flag to continue to recursively poll or not
    this._poller = function(){} // to become interval for reference to clear later

    this.__dom_loaded_queue = [];
    this.__request_queue = [];
    this.__disabled_events = [];
    this._flags = {
        'disable_all_events': false,
        'identify_called': false
    };

    this['persistence'] = this['cookie'] = new PostHogPersistence(this['config']);
    this._gdpr_init();

    var uuid = _.UUID();
    if (!this.get_distinct_id()) {
        // There is no need to set the distinct id
        // or the device id if something was already stored
        // in the persitence
        this.register_once({
            'distinct_id': uuid,
            '$device_id': uuid
        }, '');
    }
    // Set up the window close event handler "unload"
    window.addEventListener("unload", this._handle_unload.bind(this))
};

// Private methods

PostHogLib.prototype._loaded = function() {
    this.get_config('loaded')(this);

    // this happens after so a user can call identify in
    // the loaded callback
    if (this.get_config('capture_pageview')) {
        this.capture_pageview();
    }
};

PostHogLib.prototype._dom_loaded = function () {
    _.each(this.__dom_loaded_queue, function (item) {
        this._capture_dom.apply(this, item);
    }, this);

    if (!this.has_opted_out_capturing()) {
        _.each(this.__request_queue, function(item) {
            this._send_request.apply(this, item);
        }, this);
        if(this.get_config('request_batching')) {
            this._event_queue_poll()
        }
    }

    delete this.__dom_loaded_queue;
    delete this.__request_queue;
};

PostHogLib.prototype._capture_dom = function(DomClass, args) {
    if (this.get_config('img')) {
        console.error('You can\'t use DOM capturing functions with img = true.');
        return false;
    }

    if (!DOM_LOADED) {
        this.__dom_loaded_queue.push([DomClass, args]);
        return false;
    }

    var dt = new DomClass().init(this);
    return dt.capture.apply(dt, args);
};

/**
 * _prepare_callback() should be called by callers of _send_request for use
 * as the callback argument.
 *
 * If there is no callback, this returns null.
 * If we are going to make XHR/XDR requests, this returns a function.
 * If we are going to use script tags, this returns a string to use as the
 * callback GET param.
 */
PostHogLib.prototype._prepare_callback = function(callback, data) {
    if (_.isUndefined(callback)) {
        return null;
    }

    if (USE_XHR) {
        var callback_function = function(response) {
            callback(response, data);
        };
        return callback_function;
    } else {
        // if the user gives us a callback, we store as a random
        // property on this instances jsc function and update our
        // callback string to reflect that.
        var jsc = this['_jsc'];
        var randomized_cb = '' + Math.floor(Math.random() * 100000000);
        var callback_string = this.get_config('callback_fn') + '[' + randomized_cb + ']';
        jsc[randomized_cb] = function(response) {
            delete jsc[randomized_cb];
            callback(response, data);
        };
        return callback_string;
    }
};

PostHogLib.prototype._event_enqueue = function (url, data, options, callback) {
    this._event_queue.push({url, data, options, callback})

    if (!this._should_poll) {
        this._should_poll = true
        this._event_queue_poll()
    }
}

PostHogLib.prototype._format_event_queue_data = function() {
    const requests = {}
    _.each(this._event_queue, (request) => {
        const { url, data } = request
        if (requests[url] === undefined) requests[url] = []
        requests[url].push(data)
    })
    return requests
}

PostHogLib.prototype._event_queue_poll = function () {
    const POLL_INTERVAL = 3000
    this._poller = setTimeout(() => {
        if (this._event_queue.length > 0) {
            const requests = this._format_event_queue_data()
            for (let url in requests) {
                let data = requests[url];
                _.each(data, function(value, key) {
                    data[key]['offset'] = Math.abs(data[key]['timestamp'] - new Date());
                    delete data[key]['timestamp'];
                    console.log(data[key])
                })
                var json_data = _.JSONEncode(data);
                var encoded_data = _.base64Encode(json_data);
                this._send_request(url, {data: encoded_data}, __NOOPTIONS, __NOOP)
            }
            this._event_queue.length = 0 // flush the _event_queue
        } else {
            this._empty_queue_count++
        }

        /**
         * _empty_queue_count will increment each time the queue is polled
         *  and it is empty. To avoid emtpy polling (user went idle, stepped away from comp)
         *  we can turn it off with the _should_poll flag.
         * 
         * Polling will be re enabled when the next time PostHogLib.capture is called with
         *  an event that should be added to the event queue. 
         */
        if (this._empty_queue_count > 4) {
            this._should_poll = false
            this._empty_queue_count = 0
        }
        if (this._should_poll) {
            this._event_queue_poll()
        }
    }, POLL_INTERVAL)
}

PostHogLib.prototype._handle_unload = function() {
    if (!this.get_config('request_batching')) {
        this.capture('$pageleave', null, { transport: 'sendbeacon' });
        return
    }
    
    clearInterval(this._poller)
    this.capture('$pageleave')
    let data = {}
    if (this._event_queue.length > 0) {
        data = this._format_event_queue_data()
    }
    this._event_queue.length = 0
    for(let url in data) {
        // sendbeacon has some hard requirments and cant be treated 
        // like a normal post request. Because of that it needs to be encoded
        const encoded_data = _.base64Encode(_.JSONEncode(data[url]))
        this._send_request(url, {data: encoded_data}, {transport: 'sendbeacon'}, __NOOP)
    }
}

PostHogLib.prototype._send_request = function(url, data, options, callback) {
    if (ENQUEUE_REQUESTS) {
        this.__request_queue.push(arguments);
        return;
    }

    var DEFAULT_OPTIONS = {
        method: this.get_config('api_method'),
        transport: this.get_config('api_transport')
    };

    var body_data = null;

    if (!callback && (_.isFunction(options) || typeof options === 'string')) {
        callback = options;
        options = null;
    }
    options = _.extend(DEFAULT_OPTIONS, options || {});
    if (!USE_XHR) {
        options.method = 'GET';
    }

    var use_sendBeacon = sendBeacon && options.transport.toLowerCase() === 'sendbeacon';
    var use_post = use_sendBeacon || options.method === 'POST';

    // needed to correctly format responses
    var verbose_mode = this.get_config('verbose');
    if (data['verbose']) { verbose_mode = true; }

    if (this.get_config('test')) { data['test'] = 1; }
    if (verbose_mode) { data['verbose'] = 1; }
    if (this.get_config('img')) { data['img'] = 1; }
    if (!USE_XHR) {
        if (callback) {
            data['callback'] = callback;
        } else if (verbose_mode || this.get_config('test')) {
            // Verbose output (from verbose mode, or an error in test mode) is a json blob,
            // which by itself is not valid javascript. Without a callback, this verbose output will
            // cause an error when returned via jsonp, so we force a no-op callback param.
            // See the ECMA script spec: http://www.ecma-international.org/ecma-262/5.1/#sec-12.4
            data['callback'] = '(function(){})';
        }
    }

    var args = {}
    args['ip'] = this.get_config('ip') ? 1 : 0;
    args['_'] = new Date().getTime().toString();

    if (use_post) {
        if (Array.isArray(data)) {
            body_data = 'data=' + data
        } else {
            body_data = 'data=' + data['data'];
        }
        delete data['data'];
    }

    url += '?' + _.HTTPBuildQuery(args);

    if ('img' in data) {
        var img = document.createElement('img');
        img.src = url;
        document.body.appendChild(img);
    } else if (use_sendBeacon) {
        // beacon documentation https://w3c.github.io/beacon/
        // beacons format the message and use the type property
        // also no need to try catch as sendBeacon does not report errors
        //   and is defined as best effort attempt
        const body = new Blob([body_data], {type: 'application/x-www-form-urlencoded'})
        sendBeacon(url, body);
    } else if (USE_XHR) {
        try {
            var req = new XMLHttpRequest();
            req.open(options.method, url, true);
            var headers = this.get_config('xhr_headers');
            if(use_post) {
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
            }
            _.each(headers, function(headerValue, headerName) {
                req.setRequestHeader(headerName, headerValue);
            });

            // send the ph_optout cookie
            // withCredentials cannot be modified until after calling .open on Android and Mobile Safari
            req.withCredentials = true;
            req.onreadystatechange = function () {
                if (req.readyState === 4) { // XMLHttpRequest.DONE == 4, except in safari 4
                    if (req.status === 200) {
                        if (callback) {
                            if (verbose_mode) {
                                var response;
                                try {
                                    response = _.JSONDecode(req.responseText);
                                } catch (e) {
                                    console.error(e);
                                    return;
                                }
                                callback(response);
                            } else {
                                callback(Number(req.responseText));
                            }
                        }
                    } else {
                        var error = 'Bad HTTP status: ' + req.status + ' ' + req.statusText;
                        console.error(error);
                        if (callback) {
                            if (verbose_mode) {
                                callback({status: 0, error: error});
                            } else {
                                callback(0);
                            }
                        }
                    }
                }
            };
            req.send(body_data);
        } catch (e) {
            console.error(e);
        }
    } else {
        var script = document.createElement('script');
        script.type = 'text/javascript';
        script.async = true;
        script.defer = true;
        script.src = url;
        var s = document.getElementsByTagName('script')[0];
        s.parentNode.insertBefore(script, s);
    }
};

/**
 * _execute_array() deals with processing any posthog function
 * calls that were called before the PostHog library were loaded
 * (and are thus stored in an array so they can be called later)
 *
 * Note: we fire off all the posthog function calls && user defined
 * functions BEFORE we fire off posthog capturing calls. This is so
 * identify/register/set_config calls can properly modify early
 * capturing calls.
 *
 * @param {Array} array
 */
PostHogLib.prototype._execute_array = function(array) {
    var fn_name, alias_calls = [], other_calls = [], capturing_calls = [];
    _.each(array, function(item) {
        if (item) {
            fn_name = item[0];
            if (_.isArray(fn_name)) {
                capturing_calls.push(item); // chained call e.g. posthog.get_group().set()
            } else if (typeof(item) === 'function') {
                item.call(this);
            } else if (_.isArray(item) && fn_name === 'alias') {
                alias_calls.push(item);
            } else if (_.isArray(item) && fn_name.indexOf('capture') !== -1 && typeof(this[fn_name]) === 'function') {
                capturing_calls.push(item);
            } else {
                other_calls.push(item);
            }
        }
    }, this);

    var execute = function(calls, context) {
        _.each(calls, function(item) {
            if (_.isArray(item[0])) {
                // chained call
                var caller = context;
                _.each(item, function(call) {
                    caller = caller[call[0]].apply(caller, call.slice(1));
                });
            } else {
                this[item[0]].apply(this, item.slice(1));
            }
        }, context);
    };

    execute(alias_calls, this);
    execute(other_calls, this);
    execute(capturing_calls, this);
};

/**
 * push() keeps the standard async-array-push
 * behavior around after the lib is loaded.
 * This is only useful for external integrations that
 * do not wish to rely on our convenience methods
 * (created in the snippet).
 *
 * ### Usage:
 *     posthog.push(['register', { a: 'b' }]);
 *
 * @param {Array} item A [function_name, args...] array to be executed
 */
PostHogLib.prototype.push = function(item) {
    this._execute_array([item]);
};

/**
 * Capture an event. This is the most important and
 * frequently used PostHog function.
 *
 * ### Usage:
 *
 *     // capture an event named 'Registered'
 *     posthog.capture('Registered', {'Gender': 'Male', 'Age': 21});
 *
 *     // capture an event using navigator.sendBeacon
 *     posthog.capture('Left page', {'duration_seconds': 35}, {transport: 'sendBeacon'});
 *
 * To capture link clicks or form submissions, see capture_links() or capture_forms().
 *
 * @param {String} event_name The name of the event. This can be anything the user does - 'Button Click', 'Sign Up', 'Item Purchased', etc.
 * @param {Object} [properties] A set of properties to include with the event you're sending. These describe the user who did the event or details about the event itself.
 * @param {Object} [options] Optional configuration for this capture request.
 * @param {String} [options.transport] Transport method for network request ('xhr' or 'sendBeacon').
 * @param {Function} [callback] If provided, the callback function will be called after capturing the event.
 */
PostHogLib.prototype.capture = addOptOutCheckPostHogLib(function(event_name, properties, options, callback) {
    if (!callback && typeof options === 'function') {
        callback = options;
        options = null;
    }
    options = options || __NOOPTIONS;
    var transport = options['transport']; // external API, don't minify 'transport' prop
    if (transport) {
        options.transport = transport; // 'transport' prop name can be minified internally
    }
    if (typeof callback !== 'function') {
        callback = __NOOP
    }

    if (_.isUndefined(event_name)) {
        console.error('No event name provided to posthog.capture');
        return;
    }

    if (this._event_is_disabled(event_name)) {
        callback(0);
        return;
    }

    // set defaults
    properties = properties || {};
    properties['token'] = this.get_config('token');

    // set $duration if time_event was previously called for this event
    var start_timestamp = this['persistence'].remove_event_timer(event_name);
    if (!_.isUndefined(start_timestamp)) {
        var duration_in_ms = new Date().getTime() - start_timestamp;
        properties['$duration'] = parseFloat((duration_in_ms / 1000).toFixed(3));
    }

    // update persistence
    this['persistence'].update_search_keyword(document.referrer);

    if (this.get_config('store_google')) { this['persistence'].update_campaign_params(); }
    if (this.get_config('save_referrer')) { this['persistence'].update_referrer_info(document.referrer); }

    // note: extend writes to the first object, so lets make sure we
    // don't write to the persistence properties object and info
    // properties object by passing in a new object

    // update properties with pageview info and super-properties
    properties = _.extend(
        {},
        _.info.properties(),
        this['persistence'].properties(),
        properties
    );

    var property_blacklist = this.get_config('property_blacklist');
    if (_.isArray(property_blacklist)) {
        _.each(property_blacklist, function(blacklisted_prop) {
            delete properties[blacklisted_prop];
        });
    } else {
        console.error('Invalid value for property_blacklist config: ' + property_blacklist);
    }

    var data = {
        'event': event_name,
        'properties': properties,
    };

    var truncated_data  = _.truncate(data, 255);
    var json_data      = _.JSONEncode(truncated_data);
    var encoded_data   = _.base64Encode(json_data);

    const url = this.get_config('api_host') + '/e/'
    const cb = this._prepare_callback(callback, truncated_data)

    const has_unique_traits = callback !== __NOOP || options !== __NOOPTIONS

    if (!this.get_config('request_batching') || has_unique_traits) {
        this._send_request(url, {'data': encoded_data}, options, cb);
    } else {
        data['timestamp'] = new Date();
        this._event_enqueue(url, data, options, cb)
    }

    return truncated_data;
});

PostHogLib.prototype._create_map_key = function (group_key, group_id) {
    return group_key + '_' + JSON.stringify(group_id);
};

PostHogLib.prototype._remove_group_from_cache = function (group_key, group_id) {
    delete this._cached_groups[this._create_map_key(group_key, group_id)];
};

/**
 * Capture a page view event, which is currently ignored by the server.
 * This function is called by default on page load unless the
 * capture_pageview configuration variable is false.
 *
 * @param {String} [page] The url of the page to record. If you don't include this, it defaults to the current url.
 * @api private
 */
PostHogLib.prototype.capture_pageview = function(page) {
    if (_.isUndefined(page)) {
        page = document.location.href;
    }
    this.capture('$pageview');
};

/**
 * Capture clicks on a set of document elements. Selector must be a
 * valid query. Elements must exist on the page at the time capture_links is called.
 *
 * ### Usage:
 *
 *     // capture click for link id #nav
 *     posthog.capture_links('#nav', 'Clicked Nav Link');
 *
 * ### Notes:
 *
 * This function will wait up to 300 ms for the PostHog
 * servers to respond. If they have not responded by that time
 * it will head to the link without ensuring that your event
 * has been captureed.  To configure this timeout please see the
 * set_config() documentation below.
 *
 * If you pass a function in as the properties argument, the
 * function will receive the DOMElement that triggered the
 * event as an argument.  You are expected to return an object
 * from the function; any properties defined on this object
 * will be sent to posthog as event properties.
 *
 * @type {Function}
 * @param {Object|String} query A valid DOM query, element or jQuery-esque list
 * @param {String} event_name The name of the event to capture
 * @param {Object|Function} [properties] A properties object or function that returns a dictionary of properties when passed a DOMElement
 */
PostHogLib.prototype.capture_links = function() {
    return this._capture_dom.call(this, LinkCapture, arguments);
};

/**
 * Capture form submissions. Selector must be a valid query.
 *
 * ### Usage:
 *
 *     // capture submission for form id 'register'
 *     posthog.capture_forms('#register', 'Created Account');
 *
 * ### Notes:
 *
 * This function will wait up to 300 ms for the posthog
 * servers to respond, if they have not responded by that time
 * it will head to the link without ensuring that your event
 * has been captureed.  To configure this timeout please see the
 * set_config() documentation below.
 *
 * If you pass a function in as the properties argument, the
 * function will receive the DOMElement that triggered the
 * event as an argument.  You are expected to return an object
 * from the function; any properties defined on this object
 * will be sent to posthog as event properties.
 *
 * @type {Function}
 * @param {Object|String} query A valid DOM query, element or jQuery-esque list
 * @param {String} event_name The name of the event to capture
 * @param {Object|Function} [properties] This can be a set of properties, or a function that returns a set of properties after being passed a DOMElement
 */
PostHogLib.prototype.capture_forms = function() {
    return this._capture_dom.call(this, FormCaptureer, arguments);
};

/**
 * Register a set of super properties, which are included with all
 * events. This will overwrite previous super property values.
 *
 * ### Usage:
 *
 *     // register 'Gender' as a super property
 *     posthog.register({'Gender': 'Female'});
 *
 *     // register several super properties when a user signs up
 *     posthog.register({
 *         'Email': 'jdoe@example.com',
 *         'Account Type': 'Free'
 *     });
 *
 * @param {Object} properties An associative array of properties to store about the user
 * @param {Number} [days] How many days since the user's last visit to store the super properties
 */
PostHogLib.prototype.register = function(props, days) {
    this['persistence'].register(props, days);
};

/**
 * Register a set of super properties only once. This will not
 * overwrite previous super property values, unlike register().
 *
 * ### Usage:
 *
 *     // register a super property for the first time only
 *     posthog.register_once({
 *         'First Login Date': new Date().toISOString()
 *     });
 *
 * ### Notes:
 *
 * If default_value is specified, current super properties
 * with that value will be overwritten.
 *
 * @param {Object} properties An associative array of properties to store about the user
 * @param {*} [default_value] Value to override if already set in super properties (ex: 'False') Default: 'None'
 * @param {Number} [days] How many days since the users last visit to store the super properties
 */
PostHogLib.prototype.register_once = function(props, default_value, days) {
    this['persistence'].register_once(props, default_value, days);
};

/**
 * Delete a super property stored with the current user.
 *
 * @param {String} property The name of the super property to remove
 */
PostHogLib.prototype.unregister = function(property) {
    this['persistence'].unregister(property);
};

PostHogLib.prototype._register_single = function(prop, value) {
    var props = {};
    props[prop] = value;
    this.register(props);
};

/**
 * Identify a user with a unique ID instead of a PostHog
 * randomly generated distinct_id. If the method is never called,
 * then unique visitors will be identified by a UUID generated
 * the first time they visit the site.
 *
 * ### Notes:
 *
 * You can call this function to overwrite a previously set
 * unique ID for the current user. PostHog cannot translate
 * between IDs at this time, so when you change a user's ID
 * they will appear to be a new user.
 *
 * When used alone, posthog.identify will change the user's
 * distinct_id to the unique ID provided. When used in tandem
 * with posthog.alias, it will allow you to identify based on
 * unique ID and map that back to the original, anonymous
 * distinct_id given to the user upon her first arrival to your
 * site (thus connecting anonymous pre-signup activity to
 * post-signup activity). Though the two work together, do not
 * call identify() at the same time as alias(). Calling the two
 * at the same time can cause a race condition, so it is best
 * practice to call identify on the original, anonymous ID
 * right after you've aliased it.
 * <a href="https://posthog.com/help/questions/articles/how-should-i-handle-my-user-identity-with-the-posthog-javascript-library">Learn more about how posthog.identify and posthog.alias can be used</a>.
 *
 * @param {String} [unique_id] A string that uniquely identifies a user. If not provided, the distinct_id currently in the persistent store (cookie or localStorage) will be used.
 */
PostHogLib.prototype.identify = function(
    new_distinct_id, _set_callback, _set_once_callback
) {
    // Optional Parameters
    //  _set_callback:function  A callback to be run if and when the People set queue is flushed
    //  _set_once_callback:function  A callback to be run if and when the People set_once queue is flushed

    //if the new_distinct_id has not been set ignore the identify event
    if (!new_distinct_id) {
        console.error('Unique user id has not been set in posthog.identify')
        return;
    }

    var previous_distinct_id = this.get_distinct_id();
    this.register({'$user_id': new_distinct_id});

    if (!this.get_property('$device_id')) {
        // The persisted distinct id might not actually be a device id at all
        // it might be a distinct id of the user from before
        var device_id = previous_distinct_id;
        this.register_once({
            '$had_persisted_distinct_id': true,
            '$device_id': device_id
        }, '');
    }

    // identify only changes the distinct id if it doesn't match either the existing or the alias;
    // if it's new, blow away the alias as well.
    if (new_distinct_id !== previous_distinct_id && new_distinct_id !== this.get_property(ALIAS_ID_KEY)) {
        this.unregister(ALIAS_ID_KEY);
        this.register({'distinct_id': new_distinct_id});
    }
    this._flags.identify_called = true;
    // Flush any queued up people requests
    this['people']._flush(_set_callback, _set_once_callback);

    // send an $identify event any time the distinct_id is changing - logic on the server
    // will determine whether or not to do anything with it.
    if (new_distinct_id !== previous_distinct_id) {
        this.capture('$identify', { 'distinct_id': new_distinct_id, '$anon_distinct_id': previous_distinct_id });
    }
};

/**
 * Clears super properties and generates a new random distinct_id for this instance.
 * Useful for clearing data when a user logs out.
 */
PostHogLib.prototype.reset = function(reset_device_id) {
    let device_id = this.get_property('$device_id');
    this['persistence'].clear();
    this._flags.identify_called = false;
    var uuid = _.UUID();
    this.register_once({
        'distinct_id': uuid,
        '$device_id': reset_device_id ? uuid : device_id
    }, '');
};

/**
 * Returns the current distinct id of the user. This is either the id automatically
 * generated by the library or the id that has been passed by a call to identify().
 *
 * ### Notes:
 *
 * get_distinct_id() can only be called after the PostHog library has finished loading.
 * init() has a loaded function available to handle this automatically. For example:
 *
 *     // set distinct_id after the posthog library has loaded
 *     posthog.init('YOUR PROJECT TOKEN', {
 *         loaded: function(posthog) {
 *             distinct_id = posthog.get_distinct_id();
 *         }
 *     });
 */
PostHogLib.prototype.get_distinct_id = function() {
    return this.get_property('distinct_id');
};

/**
 * Create an alias, which PostHog will use to link two distinct_ids going forward (not retroactively).
 * Multiple aliases can map to the same original ID, but not vice-versa. Aliases can also be chained - the
 * following is a valid scenario:
 *
 *     posthog.alias('new_id', 'existing_id');
 *     ...
 *     posthog.alias('newer_id', 'new_id');
 *
 * If the original ID is not passed in, we will use the current distinct_id - probably the auto-generated GUID.
 *
 * ### Notes:
 *
 * The best practice is to call alias() when a unique ID is first created for a user
 * (e.g., when a user first registers for an account and provides an email address).
 * alias() should never be called more than once for a given user, except to
 * chain a newer ID to a previously new ID, as described above.
 *
 * @param {String} alias A unique identifier that you want to use for this user in the future.
 * @param {String} [original] The current identifier being used for this user.
 */
PostHogLib.prototype.alias = function(alias, original) {
    // If the $people_distinct_id key exists in persistence, there has been a previous
    // posthog.people.identify() call made for this user. It is VERY BAD to make an alias with
    // this ID, as it will duplicate users.
    if (alias === this.get_property(PEOPLE_DISTINCT_ID_KEY)) {
        console.critical('Attempting to create alias for existing People user - aborting.');
        return -2;
    }

    var _this = this;
    if (_.isUndefined(original)) {
        original = this.get_distinct_id();
    }
    if (alias !== original) {
        this._register_single(ALIAS_ID_KEY, alias);
        return this.capture('$create_alias', { 'alias': alias, 'distinct_id': original }, function() {
            // Flush the people queue
            _this.identify(alias);
        });
    } else {
        console.error('alias matches current distinct_id - skipping api call.');
        this.identify(alias);
        return -1;
    }
};

/**
 * Update the configuration of a posthog library instance.
 *
 * The default config is:
 *
 *     {
 *       // HTTP method for capturing requests
 *       api_method: 'POST'
 *
 *       // transport for sending requests ('XHR' or 'sendBeacon')
 *       // NB: sendBeacon should only be used for scenarios such as
 *       // page unload where a "best-effort" attempt to send is
 *       // acceptable; the sendBeacon API does not support callbacks
 *       // or any way to know the result of the request. PostHog
 *       // capturing via sendBeacon will not support any event-
 *       // batching or retry mechanisms.
 *       api_transport: 'XHR'
 *
 *       // super properties cookie expiration (in days)
 *       cookie_expiration: 365
 *
 *       // super properties span subdomains
 *       cross_subdomain_cookie: true
 *
 *       // debug mode
 *       debug: false
 *
 *       // if this is true, the posthog cookie or localStorage entry
 *       // will be deleted, and no user persistence will take place
 *       disable_persistence: false
 *
 *       // if this is true, PostHog will automatically determine
 *       // City, Region and Country data using the IP address of
 *       //the client
 *       ip: true
 *
 *       // opt users out of capturing by this PostHog instance by default
 *       opt_out_capturing_by_default: false
 *
 *       // opt users out of browser data storage by this PostHog instance by default
 *       opt_out_persistence_by_default: false
 *
 *       // persistence mechanism used by opt-in/opt-out methods - cookie
 *       // or localStorage - falls back to cookie if localStorage is unavailable
 *       opt_out_capturing_persistence_type: 'localStorage'
 *
 *       // customize the name of cookie/localStorage set by opt-in/opt-out methods
 *       opt_out_capturing_cookie_prefix: null
 *
 *       // type of persistent store for super properties (cookie/
 *       // localStorage) if set to 'localStorage', any existing
 *       // posthog cookie value with the same persistence_name
 *       // will be transferred to localStorage and deleted
 *       persistence: 'cookie'
 *
 *       // name for super properties persistent store
 *       persistence_name: ''
 *
 *       // names of properties/superproperties which should never
 *       // be sent with capture() calls
 *       property_blacklist: []
 *
 *       // if this is true, posthog cookies will be marked as
 *       // secure, meaning they will only be transmitted over https
 *       secure_cookie: false
 *
 *       // the amount of time capture_links will
 *       // wait for PostHog's servers to respond
 *       capture_links_timeout: 300
 *
 *       // should we capture a page view on page load
 *       capture_pageview: true
 *
 *       // if you set upgrade to be true, the library will check for
 *       // a cookie from our old js library and import super
 *       // properties from it, then the old cookie is deleted
 *       // The upgrade config option only works in the initialization,
 *       // so make sure you set it when you create the library.
 *       upgrade: false
 *
 *       // extra HTTP request headers to set for each API request, in
 *       // the format {'Header-Name': value}
 *       xhr_headers: {}
 *
 *       // protocol for fetching in-app message resources, e.g.
 *       // 'https://' or 'http://'; defaults to '//' (which defers to the
 *       // current page's protocol)
 *       inapp_protocol: '//'
 *
 *       // whether to open in-app message link in new tab/window
 *       inapp_link_new_window: false
 *     }
 *
 *
 * @param {Object} config A dictionary of new configuration values to update
 */
PostHogLib.prototype.set_config = function(config) {
    if (_.isObject(config)) {
        _.extend(this['config'], config);

        if (!this.get_config('persistence_name')) {
            this['config']['persistence_name'] = this['config']['cookie_name'];
        }
        if (!this.get_config('disable_persistence')) {
            this['config']['disable_persistence'] = this['config']['disable_cookie'];
        }

        if (this['persistence']) {
            this['persistence'].update_config(this['config']);
        }
        Config.DEBUG = Config.DEBUG || this.get_config('debug');
    }
};

/**
 * returns the current config object for the library.
 */
PostHogLib.prototype.get_config = function(prop_name) {
    return this['config'][prop_name];
};

/**
 * Returns the value of the super property named property_name. If no such
 * property is set, get_property() will return the undefined value.
 *
 * ### Notes:
 *
 * get_property() can only be called after the PostHog library has finished loading.
 * init() has a loaded function available to handle this automatically. For example:
 *
 *     // grab value for 'user_id' after the posthog library has loaded
 *     posthog.init('YOUR PROJECT TOKEN', {
 *         loaded: function(posthog) {
 *             user_id = posthog.get_property('user_id');
 *         }
 *     });
 *
 * @param {String} property_name The name of the super property you want to retrieve
 */
PostHogLib.prototype.get_property = function(property_name) {
    return this['persistence']['props'][property_name];
};

PostHogLib.prototype.toString = function() {
    var name = this.get_config('name');
    if (name !== PRIMARY_INSTANCE_NAME) {
        name = PRIMARY_INSTANCE_NAME + '.' + name;
    }
    return name;
};

PostHogLib.prototype._event_is_disabled = function(event_name) {
    return _.isBlockedUA(userAgent) ||
        this._flags.disable_all_events ||
        _.include(this.__disabled_events, event_name);
};

// perform some housekeeping around GDPR opt-in/out state
PostHogLib.prototype._gdpr_init = function() {
    var is_localStorage_requested = this.get_config('opt_out_capturing_persistence_type') === 'localStorage';

    // try to convert opt-in/out cookies to localStorage if possible
    if (is_localStorage_requested && _.localStorage.is_supported()) {
        if (!this.has_opted_in_capturing() && this.has_opted_in_capturing({'persistence_type': 'cookie'})) {
            this.opt_in_capturing({'enable_persistence': false});
        }
        if (!this.has_opted_out_capturing() && this.has_opted_out_capturing({'persistence_type': 'cookie'})) {
            this.opt_out_capturing({'clear_persistence': false});
        }
        this.clear_opt_in_out_capturing({
            'persistence_type': 'cookie',
            'enable_persistence': false
        });
    }

    // check whether the user has already opted out - if so, clear & disable persistence
    if (this.has_opted_out_capturing()) {
        this._gdpr_update_persistence({'clear_persistence': true});

    // check whether we should opt out by default
    // note: we don't clear persistence here by default since opt-out default state is often
    //       used as an initial state while GDPR information is being collected
    } else if (!this.has_opted_in_capturing() && (
        this.get_config('opt_out_capturing_by_default') || _.cookie.get('ph_optout')
    )) {
        _.cookie.remove('ph_optout');
        this.opt_out_capturing({
            'clear_persistence': this.get_config('opt_out_persistence_by_default')
        });
    }
};

/**
 * Enable or disable persistence based on options
 * only enable/disable if persistence is not already in this state
 * @param {boolean} [options.clear_persistence] If true, will delete all data stored by the sdk in persistence and disable it
 * @param {boolean} [options.enable_persistence] If true, will re-enable sdk persistence
 */
PostHogLib.prototype._gdpr_update_persistence = function(options) {
    var disabled;
    if (options && options['clear_persistence']) {
        disabled = true;
    } else if (options && options['enable_persistence']) {
        disabled = false;
    } else {
        return;
    }

    if (!this.get_config('disable_persistence') && this['persistence'].disabled !== disabled) {
        this['persistence'].set_disabled(disabled);
    }
};

// call a base gdpr function after constructing the appropriate token and options args
PostHogLib.prototype._gdpr_call_func = function(func, options) {
    options = _.extend({
        'capture': _.bind(this.capture, this),
        'persistence_type': this.get_config('opt_out_capturing_persistence_type'),
        'cookie_prefix': this.get_config('opt_out_capturing_cookie_prefix'),
        'cookie_expiration': this.get_config('cookie_expiration'),
        'cross_subdomain_cookie': this.get_config('cross_subdomain_cookie'),
        'secure_cookie': this.get_config('secure_cookie')
    }, options);

    // check if localStorage can be used for recording opt out status, fall back to cookie if not
    if (!_.localStorage.is_supported()) {
        options['persistence_type'] = 'cookie';
    }

    return func(this.get_config('token'), {
        capture: options['capture'],
        captureEventName: options['capture_event_name'],
        captureProperties: options['capture_properties'],
        persistenceType: options['persistence_type'],
        persistencePrefix: options['cookie_prefix'],
        cookieExpiration: options['cookie_expiration'],
        crossSubdomainCookie: options['cross_subdomain_cookie'],
        secureCookie: options['secure_cookie']
    });
};

/**
 * Opt the user in to data capturing and cookies/localstorage for this PostHog instance
 *
 * ### Usage
 *
 *     // opt user in
 *     posthog.opt_in_capturing();
 *
 *     // opt user in with specific event name, properties, cookie configuration
 *     posthog.opt_in_capturing({
 *         capture_event_name: 'User opted in',
 *         capture_event_properties: {
 *             'Email': 'jdoe@example.com'
 *         },
 *         cookie_expiration: 30,
 *         secure_cookie: true
 *     });
 *
 * @param {Object} [options] A dictionary of config options to override
 * @param {function} [options.capture] Function used for capturing a PostHog event to record the opt-in action (default is this PostHog instance's capture method)
 * @param {string} [options.capture_event_name=$opt_in] Event name to be used for capturing the opt-in action
 * @param {Object} [options.capture_properties] Set of properties to be captureed along with the opt-in action
 * @param {boolean} [options.enable_persistence=true] If true, will re-enable sdk persistence
 * @param {string} [options.persistence_type=localStorage] Persistence mechanism used - cookie or localStorage - falls back to cookie if localStorage is unavailable
 * @param {string} [options.cookie_prefix=__ph_opt_in_out] Custom prefix to be used in the cookie/localstorage name
 * @param {Number} [options.cookie_expiration] Number of days until the opt-in cookie expires (overrides value specified in this PostHog instance's config)
 * @param {boolean} [options.cross_subdomain_cookie] Whether the opt-in cookie is set as cross-subdomain or not (overrides value specified in this PostHog instance's config)
 * @param {boolean} [options.secure_cookie] Whether the opt-in cookie is set as secure or not (overrides value specified in this PostHog instance's config)
 */
PostHogLib.prototype.opt_in_capturing = function(options) {
    options = _.extend({
        'enable_persistence': true
    }, options);

    this._gdpr_call_func(optIn, options);
    this._gdpr_update_persistence(options);
};
PostHogLib.prototype.opt_in_captureing = function(options) {
    deprecate_warning("opt_in_captureing")
    this.opt_in_capturing(options)
}

/**
 * Opt the user out of data capturing and cookies/localstorage for this PostHog instance
 *
 * ### Usage
 *
 *     // opt user out
 *     posthog.opt_out_capturing();
 *
 *     // opt user out with different cookie configuration from PostHog instance
 *     posthog.opt_out_capturing({
 *         cookie_expiration: 30,
 *         secure_cookie: true
 *     });
 *
 * @param {Object} [options] A dictionary of config options to override
 * @param {boolean} [options.delete_user=true] If true, will delete the currently identified user's profile and clear all charges after opting the user out
 * @param {boolean} [options.clear_persistence=true] If true, will delete all data stored by the sdk in persistence
 * @param {string} [options.persistence_type=localStorage] Persistence mechanism used - cookie or localStorage - falls back to cookie if localStorage is unavailable
 * @param {string} [options.cookie_prefix=__ph_opt_in_out] Custom prefix to be used in the cookie/localstorage name
 * @param {Number} [options.cookie_expiration] Number of days until the opt-in cookie expires (overrides value specified in this PostHog instance's config)
 * @param {boolean} [options.cross_subdomain_cookie] Whether the opt-in cookie is set as cross-subdomain or not (overrides value specified in this PostHog instance's config)
 * @param {boolean} [options.secure_cookie] Whether the opt-in cookie is set as secure or not (overrides value specified in this PostHog instance's config)
 */
PostHogLib.prototype.opt_out_capturing = function(options) {
    options = _.extend({
        'clear_persistence': true,
        'delete_user': true
    }, options);

    // delete use and clear charges since these methods may be disabled by opt-out
    if (options['delete_user'] && this['people'] && this['people']._identify_called()) {
        this['people'].delete_user();
        this['people'].clear_charges();
    }

    this._gdpr_call_func(optOut, options);
    this._gdpr_update_persistence(options);
};
PostHogLib.prototype.opt_out_captureing = function(options) {
    deprecate_warning("opt_out_captureing")
    this.opt_out_capturing(options)
}

/**
 * Check whether the user has opted in to data capturing and cookies/localstorage for this PostHog instance
 *
 * ### Usage
 *
 *     var has_opted_in = posthog.has_opted_in_capturing();
 *     // use has_opted_in value
 *
 * @param {Object} [options] A dictionary of config options to override
 * @param {string} [options.persistence_type=localStorage] Persistence mechanism used - cookie or localStorage - falls back to cookie if localStorage is unavailable
 * @param {string} [options.cookie_prefix=__ph_opt_in_out] Custom prefix to be used in the cookie/localstorage name
 * @returns {boolean} current opt-in status
 */
PostHogLib.prototype.has_opted_in_capturing = function(options) {
    return this._gdpr_call_func(hasOptedIn, options);
};
PostHogLib.prototype.has_opted_in_captureing = function(options) {
    deprecate_warning("has_opted_in_captureing")
    return this.has_opted_in_capturing(options)
}

/**
 * Check whether the user has opted out of data capturing and cookies/localstorage for this PostHog instance
 *
 * ### Usage
 *
 *     var has_opted_out = posthog.has_opted_out_capturing();
 *     // use has_opted_out value
 *
 * @param {Object} [options] A dictionary of config options to override
 * @param {string} [options.persistence_type=localStorage] Persistence mechanism used - cookie or localStorage - falls back to cookie if localStorage is unavailable
 * @param {string} [options.cookie_prefix=__ph_opt_in_out] Custom prefix to be used in the cookie/localstorage name
 * @returns {boolean} current opt-out status
 */
PostHogLib.prototype.has_opted_out_capturing = function(options) {
    return this._gdpr_call_func(hasOptedOut, options);
};
PostHogLib.prototype.has_opted_out_captureing = function(options) {
    deprecate_warning("has_opted_out_captureing")
    return this.has_opted_out_capturing(options)
}

/**
 * Clear the user's opt in/out status of data capturing and cookies/localstorage for this PostHog instance
 *
 * ### Usage
 *
 *     // clear user's opt-in/out status
 *     posthog.clear_opt_in_out_capturing();
 *
 *     // clear user's opt-in/out status with specific cookie configuration - should match
 *     // configuration used when opt_in_capturing/opt_out_capturing methods were called.
 *     posthog.clear_opt_in_out_capturing({
 *         cookie_expiration: 30,
 *         secure_cookie: true
 *     });
 *
 * @param {Object} [options] A dictionary of config options to override
 * @param {boolean} [options.enable_persistence=true] If true, will re-enable sdk persistence
 * @param {string} [options.persistence_type=localStorage] Persistence mechanism used - cookie or localStorage - falls back to cookie if localStorage is unavailable
 * @param {string} [options.cookie_prefix=__ph_opt_in_out] Custom prefix to be used in the cookie/localstorage name
 * @param {Number} [options.cookie_expiration] Number of days until the opt-in cookie expires (overrides value specified in this PostHog instance's config)
 * @param {boolean} [options.cross_subdomain_cookie] Whether the opt-in cookie is set as cross-subdomain or not (overrides value specified in this PostHog instance's config)
 * @param {boolean} [options.secure_cookie] Whether the opt-in cookie is set as secure or not (overrides value specified in this PostHog instance's config)
 */
PostHogLib.prototype.clear_opt_in_out_capturing = function(options) {
    options = _.extend({
        'enable_persistence': true
    }, options);

    this._gdpr_call_func(clearOptInOut, options);
    this._gdpr_update_persistence(options);
};
PostHogLib.prototype.clear_opt_in_out_captureing = function(options) {
    deprecate_warning("clear_opt_in_out_captureing")
    this.clear_opt_in_out_capturing(options)
}

function deprecate_warning(method) {
    window.console.warn("WARNING! posthog." + method + " is deprecated and will be removed soon! Please use posthog." + (method.split('captureing').join('capturing')) + " instead (without the \"e\")!")
}

// EXPORTS (for closure compiler)

// PostHogLib Exports
PostHogLib.prototype['init']                               = PostHogLib.prototype.init;
PostHogLib.prototype['reset']                              = PostHogLib.prototype.reset;
PostHogLib.prototype['capture']                            = PostHogLib.prototype.capture;
PostHogLib.prototype['capture_links']                      = PostHogLib.prototype.capture_links;
PostHogLib.prototype['capture_forms']                      = PostHogLib.prototype.capture_forms;
PostHogLib.prototype['capture_pageview']                   = PostHogLib.prototype.capture_pageview;
PostHogLib.prototype['register']                           = PostHogLib.prototype.register;
PostHogLib.prototype['register_once']                      = PostHogLib.prototype.register_once;
PostHogLib.prototype['unregister']                         = PostHogLib.prototype.unregister;
PostHogLib.prototype['identify']                           = PostHogLib.prototype.identify;
PostHogLib.prototype['alias']                              = PostHogLib.prototype.alias;
PostHogLib.prototype['set_config']                         = PostHogLib.prototype.set_config;
PostHogLib.prototype['get_config']                         = PostHogLib.prototype.get_config;
PostHogLib.prototype['get_property']                       = PostHogLib.prototype.get_property;
PostHogLib.prototype['get_distinct_id']                    = PostHogLib.prototype.get_distinct_id;
PostHogLib.prototype['toString']                           = PostHogLib.prototype.toString;
PostHogLib.prototype['opt_out_captureing']                 = PostHogLib.prototype.opt_out_captureing;
PostHogLib.prototype['opt_in_captureing']                  = PostHogLib.prototype.opt_in_captureing;
PostHogLib.prototype['has_opted_out_captureing']           = PostHogLib.prototype.has_opted_out_captureing;
PostHogLib.prototype['has_opted_in_captureing']            = PostHogLib.prototype.has_opted_in_captureing;
PostHogLib.prototype['clear_opt_in_out_captureing']        = PostHogLib.prototype.clear_opt_in_out_captureing;
PostHogLib.prototype['opt_out_capturing']                  = PostHogLib.prototype.opt_out_capturing;
PostHogLib.prototype['opt_in_capturing']                   = PostHogLib.prototype.opt_in_capturing;
PostHogLib.prototype['has_opted_out_capturing']            = PostHogLib.prototype.has_opted_out_capturing;
PostHogLib.prototype['has_opted_in_capturing']             = PostHogLib.prototype.has_opted_in_capturing;
PostHogLib.prototype['clear_opt_in_out_capturing']         = PostHogLib.prototype.clear_opt_in_out_capturing;

// PostHogPersistence Exports
PostHogPersistence.prototype['properties']            = PostHogPersistence.prototype.properties;
PostHogPersistence.prototype['update_search_keyword'] = PostHogPersistence.prototype.update_search_keyword;
PostHogPersistence.prototype['update_referrer_info']  = PostHogPersistence.prototype.update_referrer_info;
PostHogPersistence.prototype['get_cross_subdomain']   = PostHogPersistence.prototype.get_cross_subdomain;
PostHogPersistence.prototype['clear']                 = PostHogPersistence.prototype.clear;

_.safewrap_class(PostHogLib, ['identify']);


var instances = {};
var extend_mp = function() {
    // add all the sub posthog instances
    _.each(instances, function(instance, name) {
        if (name !== PRIMARY_INSTANCE_NAME) { posthog_master[name] = instance; }
    });

    // add private functions as _
    posthog_master['_'] = _;
};

var override_ph_init_func = function() {
    // we override the snippets init function to handle the case where a
    // user initializes the posthog library after the script loads & runs
    posthog_master['init'] = function(token, config, name) {
        if (name) {
            // initialize a sub library
            if (!posthog_master[name]) {
                posthog_master[name] = instances[name] = create_mplib(token, config, name);
                posthog_master[name]._loaded();
            }
            return posthog_master[name];
        } else {
            var instance = posthog_master;

            if (instances[PRIMARY_INSTANCE_NAME]) {
                // main posthog lib already initialized
                instance = instances[PRIMARY_INSTANCE_NAME];
            } else if (token) {
                // intialize the main posthog lib
                instance = create_mplib(token, config, PRIMARY_INSTANCE_NAME);
                instance._loaded();
                instances[PRIMARY_INSTANCE_NAME] = instance;
            }

            posthog_master = instance;
            if (init_type === INIT_SNIPPET) {
                window[PRIMARY_INSTANCE_NAME] = posthog_master;
            }
            extend_mp();
        }
    };
};

var add_dom_loaded_handler = function() {
    // Cross browser DOM Loaded support
    function dom_loaded_handler() {
        // function flag since we only want to execute this once
        if (dom_loaded_handler.done) { return; }
        dom_loaded_handler.done = true;

        DOM_LOADED = true;
        ENQUEUE_REQUESTS = false;

        _.each(instances, function(inst) {
            inst._dom_loaded();
        });
    }

    function do_scroll_check() {
        try {
            document.documentElement.doScroll('left');
        } catch(e) {
            setTimeout(do_scroll_check, 1);
            return;
        }

        dom_loaded_handler();
    }

    if (document.addEventListener) {
        if (document.readyState === 'complete') {
            // safari 4 can fire the DOMContentLoaded event before loading all
            // external JS (including this file). you will see some copypasta
            // on the internet that checks for 'complete' and 'loaded', but
            // 'loaded' is an IE thing
            dom_loaded_handler();
        } else {
            document.addEventListener('DOMContentLoaded', dom_loaded_handler, false);
        }
    } else if (document.attachEvent) {
        // IE
        document.attachEvent('onreadystatechange', dom_loaded_handler);

        // check to make sure we arn't in a frame
        var toplevel = false;
        try {
            toplevel = window.frameElement === null;
        } catch(e) {
            // noop
        }

        if (document.documentElement.doScroll && toplevel) {
            do_scroll_check();
        }
    }

    // fallback handler, always will work
    _.register_event(window, 'load', dom_loaded_handler, true);
};

export function init_from_snippet() {
    init_type = INIT_SNIPPET;
    if(_.isUndefined(window.posthog)) window.posthog = [];
    posthog_master = window.posthog;

    if (posthog_master['__loaded'] || (posthog_master['config'] && posthog_master['persistence'])) {
        // lib has already been loaded at least once; we don't want to override the global object this time so bomb early
        console.error('PostHog library has already been downloaded at least once.');
        return;
    }
    // Load instances of the PostHog Library
    _.each(posthog_master['_i'], function(item) {
        if (item && _.isArray(item)) {
            instances[item[item.length-1]] = create_mplib.apply(this, item);
        }
    });

    override_ph_init_func();
    posthog_master['init']();

    // Fire loaded events after updating the window's posthog object
    _.each(instances, function(instance) {
        instance._loaded();
    });

    add_dom_loaded_handler();
}

export function init_as_module() {
    init_type = INIT_MODULE;
    posthog_master = new PostHogLib();

    override_ph_init_func();
    posthog_master['init']();
    add_dom_loaded_handler();

    return posthog_master;
}
