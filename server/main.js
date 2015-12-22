'use strict';
var restify = require('restify');
var server = restify.createServer();
server.use(restify.bodyParser());

var sessions = require("client-sessions");
server.use(sessions({
    cookieName: 'depotSession',
    secret: 'DolanGooby',
    duration: 3 * 24 * 60 * 60 * 1000
}));

var mongoose = require('mongoose');
var Schema = mongoose.Schema;
mongoose.connect('mongodb://admin:admin@ds056688.mongolab.com:56688/depot');

var AccountSchema = new Schema({
    username: String,
    password: String,
    orders: [Schema.Types.ObjectId],
    orders_taken: [Schema.Types.ObjectId],
    type: String
});

var OrderSchema = new Schema({
    state: String,
    items: [{
        product: Schema.Types.ObjectId,
        amount: Number
    }],
    submitted: Boolean,
    ordered_by: String,
    taken_by: String
});

var ProductSchema = new Schema({
    name: String,
    stock: Number,
    price: Number
});

var Account = mongoose.model('Accounts', AccountSchema);
var Order = mongoose.model('Order', OrderSchema);
var Product = mongoose.model('Product', ProductSchema);

server.pre(function (req, res, next) {
    req.headers.accept = 'application/json';
    return next();
});

function checkLoginned(req, res, next) {
    if (! req.depotSession.username) return next(new restify.UnauthorizedError("NOT YET LOGINNED"));
    return next();
}

function checkAdmin(req, res, next) {
    Account.findOne({ username: req.depotSession.username }, function (err, user) {
        if (err) return next(new restify.InternalServerError("DATABASE ERROR"));
        if (! user) return next(new restify.UnauthorizedError("USER NOT EXIST"));
        if (user.type != 'admin') return next(new restify.ForbiddenError("CUSTOMER NOT ALLOWED"));
        return next();
    });
}

server.post('/register', function(req, res, next) {
    if (! req.params.username || ! req.params.password) return next(new restify.BadRequestError('WRONG FORMAT'));

    Account.findOne({ username: req.params.username }, function(err, user) {
        if (err) return next(new restify.InternalServerError("DATABASE ERROR"));
        if (user) return next(new restify.ForbiddenError('USERNAME EXISTED'));

        var user = new Account({
            username: req.params.username,
            password: req.params.password,
            type: 'customer'
        });
        user.save(function(err) {
            if (err) return next(new restify.InternalServerError("DATABASE ERROR"));
            res.send(200);
        });
    });
});

server.post('/login', function(req, res, next) {
    if (! req.params.username || ! req.params.password) return next(new restify.BadRequestError('WRONG FORMAT'));

    Account.findOne({ username: req.params.username }, function(err, user) {
        if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
        if (! user) return next(new restify.UnautorizedError('USER NOT EXISTED'));
        if (user.password != req.params.password) return next(new restify.UnauthorizedError('WRONG PASSWORD'));
        
        req.depotSession.username = req.params.username;
        res.send(200);
    });
});

server.get('/logout', checkLoginned, function(req, res, next) {
    req.depotSession.reset();
    res.send(200);
});

server.get('/products', function(req, res, next) {
    Product.find({}, function(err, products) {
        res.send(200, products);
    });
});

server.post('/products', checkLoginned, checkAdmin, function(req, res, next) {
    for (let item of req.params) if (! item.name) return next(new restify.BadRequestError('WRONG FORMAT'));

    let saved = 0;
    for (let item of req.params) {
        Product.findOne({ name: item.name }, function(err, product) {
            if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
            if (product) return next(new restify.ForbiddenError('PRODUCT DEFINED'));
            
            product = new Product({
                name: item.name,
                stock: item.stock,
                price: item.price
            });
            product.save(function(err) {
                if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
                if (++saved == req.params.length) res.send(200);
            });
        });
    }
});

server.put('/products', checkLoginned, checkAdmin, function(req, res, next) {
    let saved = 0;
    for (let item of req.params) {
        if (! item.id) return next(new restify.BadRequestError('WRONG FORMAT'));

        Product.findOne({ _id: item.id }, function(err, product) {
            if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
            if (! product) return next(new restify.BadRequest('PRODUCT NOT EXISTED'));

            Product.findOne({ name: item.name }, function(err, product) {
                if (product) return next(new restify.ForbiddenError('PRODUCT NAME EXISTED'));
            
                if (item.name) product.name = item.name;
                if (item.stock) product.stock = item.stock;
                if (item.price) product.price = item.price;
                product.save(function(err) {
                    if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
                    if (++saved == req.params.length) res.send(200);
                });
            });
        });
    }
});

server.del('/products', checkLoginned, checkAdmin, function(req, res, next) {
    req.params.forEach(function(product) {
        if (product.id) {
            Product.findOne({ _id: product.id }).remove().exec();
            res.send(200);
        }
    });
});

server.get('/orders', checkLoginned, function(req, res, next) { 
    Account.findOne({ username: req.depotSession.username }, function(err, user) {
        if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
        if (! user) return next(new restify.UnautorizedError('USER NOT EXISTED'));

        var response = {};
        Account.findOne({ username: req.depotSession.username }, function(err, user) {
            if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
            
            response.MY_ORDERS = user.orders;
            if (user.type == 'customer') {
                res.send(200, response);
            } else if (user.type == 'admin') {
                response.I_TAKE = [];
                response.NOT_TAKEN = [];
                Order.find({}, function(err, orders) {
                    if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
                    for (let order of orders) {
                        if (! order.taken_by) response.NOT_TAKEN.push(order._id);
                        if (order.taken_by == user.username) response.I_TAKE.push(order._id);
                    }
                    res.send(200, response);
                });
            }
        });
    });
});

server.post('/orders', checkLoginned, function(req, res, next) {
    for (let item of req.params) if (! item.productId) return next(new restify.BadRequestError('WRONG FORMAT'));

    var total = 0;
    var items = [];

    req.params.forEach(function (item) {
        Product.findOne({ _id: item.productId }, function(err, product) {
            if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
            if (! product) return next(new restify.BadRequestError('PRODUCT NOT EXISTED'));
            if (product.stock < item.amount) return next(new restify.Forbidden('STOCK NOT AVAILABLE'));
            
            product.stock -= item.amount;
            product.save(function(err) {
                if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
                total += item.amount * product.price;
                items.push({
                    product: item.productId,
                    amount: item.amount
                });

                if (items.length == req.params.length) {
                    var order = new Order({
                        state: 'archived',
                        items: items,
                        ordered_by: req.depotSession.username
                    });
                    order.save(function(err) {
                        if (err) return next(new restify.InternalServerError('DATABASE ERROR'));
                        Account.findOne({ username: req.depotSession.username }, function(err, user) {
                            user.orders.push(order._id);
                            user.save(function(err) {
                                if (err) return next(new restify.InternalServerError("DATABASE ERROR"));
                                res.send(200, { total: total });
                            });
                        });
                    })
                }
            });
        });
    });
});

server.listen(80);
