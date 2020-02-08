/* eslint camelcase: "off" */
import { addOptOutCheckPostHogPeople } from './gdpr-utils';
import {
    SET_ACTION,
    SET_ONCE_ACTION,
    UNSET_ACTION,
    ADD_ACTION,
    APPEND_ACTION,
    REMOVE_ACTION,
    UNION_ACTION,
    apiActions
} from './api-actions';
import { _, console } from './utils';

/**
 * PostHog People Object
 * @constructor
 */
var PostHogPeople = function() {};

_.extend(PostHogPeople.prototype, apiActions);

PostHogPeople.prototype._init = function(posthog_instance) {
    this._posthog = posthog_instance;
};

/*
* Set properties on a user record.
*
* ### Usage:
*
*     posthog.people.set('gender', 'm');
*
*     // or set multiple properties at once
*     posthog.people.set({
*         'Company': 'Acme',
*         'Plan': 'Premium',
*         'Upgrade date': new Date()
*     });
*     // properties can be strings, integers, dates, or lists
*
* @param {Object|String} prop If a string, this is the name of the property. If an object, this is an associative array of names and values.
* @param {*} [to] A value to set on the given property name
* @param {Function} [callback] If provided, the callback will be called after captureing the event.
*/
PostHogPeople.prototype.set = addOptOutCheckPostHogPeople(function(prop, to, callback) {
    var data = this.set_action(prop, to);
    if (_.isObject(prop)) {
        callback = to;
    }
    // make sure that the referrer info has been updated and saved
    if (this._get_config('save_referrer')) {
        this._posthog['persistence'].update_referrer_info(document.referrer);
    }

    // update $set object with default people properties
    data[SET_ACTION] = _.extend(
        {},
        _.info.people_properties(),
        this._posthog['persistence'].get_referrer_info(),
        data[SET_ACTION]
    );
    return this._send_request(data, callback);
});

/*
* Set properties on a user record, only if they do not yet exist.
* This will not overwrite previous people property values, unlike
* people.set().
*
* ### Usage:
*
*     posthog.people.set_once('First Login Date', new Date());
*
*     // or set multiple properties at once
*     posthog.people.set_once({
*         'First Login Date': new Date(),
*         'Starting Plan': 'Premium'
*     });
*
*     // properties can be strings, integers or dates
*
* @param {Object|String} prop If a string, this is the name of the property. If an object, this is an associative array of names and values.
* @param {*} [to] A value to set on the given property name
* @param {Function} [callback] If provided, the callback will be called after captureing the event.
*/
PostHogPeople.prototype.set_once = addOptOutCheckPostHogPeople(function(prop, to, callback) {
    var data = this.set_once_action(prop, to);
    if (_.isObject(prop)) {
        callback = to;
    }
    return this._send_request(data, callback);
});

/*
* Unset properties on a user record (permanently removes the properties and their values from a profile).
*
* ### Usage:
*
*     posthog.people.unset('gender');
*
*     // or unset multiple properties at once
*     posthog.people.unset(['gender', 'Company']);
*
* @param {Array|String} prop If a string, this is the name of the property. If an array, this is a list of property names.
* @param {Function} [callback] If provided, the callback will be called after captureing the event.
*/
PostHogPeople.prototype.unset = addOptOutCheckPostHogPeople(function(prop, callback) {
    var data = this.unset_action(prop);
    return this._send_request(data, callback);
});

/*
* Increment/decrement numeric people analytics properties.
*
* ### Usage:
*
*     posthog.people.increment('page_views', 1);
*
*     // or, for convenience, if you're just incrementing a counter by
*     // 1, you can simply do
*     posthog.people.increment('page_views');
*
*     // to decrement a counter, pass a negative number
*     posthog.people.increment('credits_left', -1);
*
*     // like posthog.people.set(), you can increment multiple
*     // properties at once:
*     posthog.people.increment({
*         counter1: 1,
*         counter2: 6
*     });
*
* @param {Object|String} prop If a string, this is the name of the property. If an object, this is an associative array of names and numeric values.
* @param {Number} [by] An amount to increment the given property
* @param {Function} [callback] If provided, the callback will be called after captureing the event.
*/
PostHogPeople.prototype.increment = addOptOutCheckPostHogPeople(function(prop, by, callback) {
    var data = {};
    var $add = {};
    if (_.isObject(prop)) {
        _.each(prop, function(v, k) {
            if (!this._is_reserved_property(k)) {
                if (isNaN(parseFloat(v))) {
                    console.error('Invalid increment value passed to posthog.people.increment - must be a number');
                    return;
                } else {
                    $add[k] = v;
                }
            }
        }, this);
        callback = by;
    } else {
        // convenience: posthog.people.increment('property'); will
        // increment 'property' by 1
        if (_.isUndefined(by)) {
            by = 1;
        }
        $add[prop] = by;
    }
    data[ADD_ACTION] = $add;

    return this._send_request(data, callback);
});

/*
* Append a value to a list-valued people analytics property.
*
* ### Usage:
*
*     // append a value to a list, creating it if needed
*     posthog.people.append('pages_visited', 'homepage');
*
*     // like posthog.people.set(), you can append multiple
*     // properties at once:
*     posthog.people.append({
*         list1: 'bob',
*         list2: 123
*     });
*
* @param {Object|String} list_name If a string, this is the name of the property. If an object, this is an associative array of names and values.
* @param {*} [value] value An item to append to the list
* @param {Function} [callback] If provided, the callback will be called after captureing the event.
*/
PostHogPeople.prototype.append = addOptOutCheckPostHogPeople(function(list_name, value, callback) {
    if (_.isObject(list_name)) {
        callback = value;
    }
    var data = this.append_action(list_name, value);
    return this._send_request(data, callback);
});

/*
* Remove a value from a list-valued people analytics property.
*
* ### Usage:
*
*     posthog.people.remove('School', 'UCB');
*
* @param {Object|String} list_name If a string, this is the name of the property. If an object, this is an associative array of names and values.
* @param {*} [value] value Item to remove from the list
* @param {Function} [callback] If provided, the callback will be called after captureing the event.
*/
PostHogPeople.prototype.remove = addOptOutCheckPostHogPeople(function(list_name, value, callback) {
    if (_.isObject(list_name)) {
        callback = value;
    }
    var data = this.remove_action(list_name, value);
    return this._send_request(data, callback);
});

/*
* Merge a given list with a list-valued people analytics property,
* excluding duplicate values.
*
* ### Usage:
*
*     // merge a value to a list, creating it if needed
*     posthog.people.union('pages_visited', 'homepage');
*
*     // like posthog.people.set(), you can append multiple
*     // properties at once:
*     posthog.people.union({
*         list1: 'bob',
*         list2: 123
*     });
*
*     // like posthog.people.append(), you can append multiple
*     // values to the same list:
*     posthog.people.union({
*         list1: ['bob', 'billy']
*     });
*
* @param {Object|String} list_name If a string, this is the name of the property. If an object, this is an associative array of names and values.
* @param {*} [value] Value / values to merge with the given property
* @param {Function} [callback] If provided, the callback will be called after captureing the event.
*/
PostHogPeople.prototype.union = addOptOutCheckPostHogPeople(function(list_name, values, callback) {
    if (_.isObject(list_name)) {
        callback = values;
    }
    var data = this.union_action(list_name, values);
    return this._send_request(data, callback);
});

/*
* Record that you have charged the current user a certain amount
* of money. Charges recorded with capture_charge() will appear in the
* PostHog revenue report.
*
* ### Usage:
*
*     // charge a user $50
*     posthog.people.capture_charge(50);
*
*     // charge a user $30.50 on the 2nd of january
*     posthog.people.capture_charge(30.50, {
*         '$time': new Date('jan 1 2012')
*     });
*
* @param {Number} amount The amount of money charged to the current user
* @param {Object} [properties] An associative array of properties associated with the charge
* @param {Function} [callback] If provided, the callback will be called when the server responds
*/
PostHogPeople.prototype.capture_charge = addOptOutCheckPostHogPeople(function(amount, properties, callback) {
    if (!_.isNumber(amount)) {
        amount = parseFloat(amount);
        if (isNaN(amount)) {
            console.error('Invalid value passed to posthog.people.capture_charge - must be a number');
            return;
        }
    }

    return this.append('$transactions', _.extend({
        '$amount': amount
    }, properties), callback);
});

/*
* Permanently clear all revenue report transactions from the
* current user's people analytics profile.
*
* ### Usage:
*
*     posthog.people.clear_charges();
*
* @param {Function} [callback] If provided, the callback will be called after captureing the event.
*/
PostHogPeople.prototype.clear_charges = function(callback) {
    return this.set('$transactions', [], callback);
};

/*
* Permanently deletes the current people analytics profile from
* PostHog (using the current distinct_id).
*
* ### Usage:
*
*     // remove the all data you have stored about the current user
*     posthog.people.delete_user();
*
*/
PostHogPeople.prototype.delete_user = function() {
    if (!this._identify_called()) {
        console.error('posthog.people.delete_user() requires you to call identify() first');
        return;
    }
    var data = {'$delete': this._posthog.get_distinct_id()};
    return this._send_request(data);
};

PostHogPeople.prototype.toString = function() {
    return this._posthog.toString() + '.people';
};

PostHogPeople.prototype._send_request = function(data, callback) {
    data['$token'] = this._get_config('token');
    data['$distinct_id'] = this._posthog.get_distinct_id();
    var device_id = this._posthog.get_property('$device_id');
    var user_id = this._posthog.get_property('$user_id');
    var had_persisted_distinct_id = this._posthog.get_property('$had_persisted_distinct_id');
    if (device_id) {
        data['$device_id'] = device_id;
    }
    if (user_id) {
        data['$user_id'] = user_id;
    }
    if (had_persisted_distinct_id) {
        data['$had_persisted_distinct_id'] = had_persisted_distinct_id;
    }

    var date_encoded_data = _.encodeDates(data);
    var truncated_data    = _.truncate(date_encoded_data, 255);
    var json_data         = _.JSONEncode(date_encoded_data);
    var encoded_data      = _.base64Encode(json_data);

    if (!this._identify_called()) {
        this._enqueue(data);
        if (!_.isUndefined(callback)) {
            if (this._get_config('verbose')) {
                callback({status: -1, error: null});
            } else {
                callback(-1);
            }
        }
        return truncated_data;
    }

    console.log('POSTHOG PEOPLE REQUEST:');
    console.log(truncated_data);

    this._posthog._send_request(
        this._get_config('api_host') + '/engage/',
        {'data': encoded_data},
        this._posthog._prepare_callback(callback, truncated_data)
    );

    return truncated_data;
};

PostHogPeople.prototype._get_config = function(conf_var) {
    return this._posthog.get_config(conf_var);
};

PostHogPeople.prototype._identify_called = function() {
    return this._posthog._flags.identify_called === true;
};

// Queue up engage operations if identify hasn't been called yet.
PostHogPeople.prototype._enqueue = function(data) {
    if (SET_ACTION in data) {
        this._posthog['persistence']._add_to_people_queue(SET_ACTION, data);
    } else if (SET_ONCE_ACTION in data) {
        this._posthog['persistence']._add_to_people_queue(SET_ONCE_ACTION, data);
    } else if (UNSET_ACTION in data) {
        this._posthog['persistence']._add_to_people_queue(UNSET_ACTION, data);
    } else if (ADD_ACTION in data) {
        this._posthog['persistence']._add_to_people_queue(ADD_ACTION, data);
    } else if (APPEND_ACTION in data) {
        this._posthog['persistence']._add_to_people_queue(APPEND_ACTION, data);
    } else if (REMOVE_ACTION in data) {
        this._posthog['persistence']._add_to_people_queue(REMOVE_ACTION, data);
    } else if (UNION_ACTION in data) {
        this._posthog['persistence']._add_to_people_queue(UNION_ACTION, data);
    } else {
        console.error('Invalid call to _enqueue():', data);
    }
};

PostHogPeople.prototype._flush_one_queue = function(action, action_method, callback, queue_to_params_fn) {
    var _this = this;
    var queued_data = _.extend({}, this._posthog['persistence']._get_queue(action));
    var action_params = queued_data;

    if (!_.isUndefined(queued_data) && _.isObject(queued_data) && !_.isEmptyObject(queued_data)) {
        _this._posthog['persistence']._pop_from_people_queue(action, queued_data);
        if (queue_to_params_fn) {
            action_params = queue_to_params_fn(queued_data);
        }
        action_method.call(_this, action_params, function(response, data) {
            // on bad response, we want to add it back to the queue
            if (response === 0) {
                _this._posthog['persistence']._add_to_people_queue(action, queued_data);
            }
            if (!_.isUndefined(callback)) {
                callback(response, data);
            }
        });
    }
};

// Flush queued engage operations - order does not matter,
// and there are network level race conditions anyway
PostHogPeople.prototype._flush = function(
    _set_callback, _add_callback, _append_callback, _set_once_callback, _union_callback, _unset_callback, _remove_callback
) {
    var _this = this;
    var $append_queue = this._posthog['persistence']._get_queue(APPEND_ACTION);
    var $remove_queue = this._posthog['persistence']._get_queue(REMOVE_ACTION);

    this._flush_one_queue(SET_ACTION, this.set, _set_callback);
    this._flush_one_queue(SET_ONCE_ACTION, this.set_once, _set_once_callback);
    this._flush_one_queue(UNSET_ACTION, this.unset, _unset_callback, function(queue) { return _.keys(queue); });
    this._flush_one_queue(ADD_ACTION, this.increment, _add_callback);
    this._flush_one_queue(UNION_ACTION, this.union, _union_callback);

    // we have to fire off each $append individually since there is
    // no concat method server side
    if (!_.isUndefined($append_queue) && _.isArray($append_queue) && $append_queue.length) {
        var $append_item;
        var append_callback = function(response, data) {
            if (response === 0) {
                _this._posthog['persistence']._add_to_people_queue(APPEND_ACTION, $append_item);
            }
            if (!_.isUndefined(_append_callback)) {
                _append_callback(response, data);
            }
        };
        for (var i = $append_queue.length - 1; i >= 0; i--) {
            $append_item = $append_queue.pop();
            if (!_.isEmptyObject($append_item)) {
                _this.append($append_item, append_callback);
            }
        }
        // Save the shortened append queue
        _this._posthog['persistence'].save();
    }

    // same for $remove
    if (!_.isUndefined($remove_queue) && _.isArray($remove_queue) && $remove_queue.length) {
        var $remove_item;
        var remove_callback = function(response, data) {
            if (response === 0) {
                _this._posthog['persistence']._add_to_people_queue(REMOVE_ACTION, $remove_item);
            }
            if (!_.isUndefined(_remove_callback)) {
                _remove_callback(response, data);
            }
        };
        for (var j = $remove_queue.length - 1; j >= 0; j--) {
            $remove_item = $remove_queue.pop();
            if (!_.isEmptyObject($remove_item)) {
                _this.remove($remove_item, remove_callback);
            }
        }
        _this._posthog['persistence'].save();
    }
};

PostHogPeople.prototype._is_reserved_property = function(prop) {
    return prop === '$distinct_id' || prop === '$token' || prop === '$device_id' || prop === '$user_id' || prop === '$had_persisted_distinct_id';
};

// PostHogPeople Exports
PostHogPeople.prototype['set']           = PostHogPeople.prototype.set;
PostHogPeople.prototype['set_once']      = PostHogPeople.prototype.set_once;
PostHogPeople.prototype['unset']         = PostHogPeople.prototype.unset;
PostHogPeople.prototype['increment']     = PostHogPeople.prototype.increment;
PostHogPeople.prototype['append']        = PostHogPeople.prototype.append;
PostHogPeople.prototype['remove']        = PostHogPeople.prototype.remove;
PostHogPeople.prototype['union']         = PostHogPeople.prototype.union;
PostHogPeople.prototype['capture_charge']  = PostHogPeople.prototype.capture_charge;
PostHogPeople.prototype['clear_charges'] = PostHogPeople.prototype.clear_charges;
PostHogPeople.prototype['delete_user']   = PostHogPeople.prototype.delete_user;
PostHogPeople.prototype['toString']      = PostHogPeople.prototype.toString;

export { PostHogPeople };
