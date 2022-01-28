'use strict';

require('ejs');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const express = require('express');
const sessions = require('express-session');
const MongoStore = require('connect-mongo');
const cookieParser = require('cookie-parser');
const { createHash } = require('crypto');


(async () => {
    const dbConn = await require('./db/mongoose')();  // function call!
    const Skin = require('./db/models/skin');
    const User = require('./db/models/user');

    const app = express();
    const fileStorageEngine = multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, "./images");
        },
        filename: (req, file, cb) => {
            cb(null, Date.now() + "--" + file.originalname);
        }
    });
    const upload = multer({ storage: fileStorageEngine });

    app.set('views', './src/views');
    app.set('view engine', 'ejs');
    app.use(express.static('./src/static'));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());
    app.use(sessions({
        secret: JSON.parse(fs.readFileSync('./src/secret-data.json', 'utf-8')).sessionSecret,
        saveUninitialized: true,
        cookie: { maxAge: 1000 * 60 * 60 * 24 * 1 }, // a day
        resave: false,
        store: MongoStore.create({ client: dbConn.getClient() })
    }));


    app.get('/', auth, upload.single(), (req, res) => {
        if (req.session.userid) {
            res.render('index', { user: req.session.userid, admin: req.session.admin });
        } else {
            res.render('index', { message: req.query.message });
        }
    });

    app.post('/items', upload.single(), async (req, res) => {
        // req.body -- filters
        let pageNo = req.body.pageNo || 0;
        let skinsOnPage = req.body.skinsOnPage || 18;

        const result = await Skin.find({})
            .lean()
            .skip(pageNo * skinsOnPage)
            .limit(skinsOnPage);
        res.json(result);
    });

    app.get('/item/:name', async (req, res) => {
        const item = await Skin.findOne({ name: req.params.name }).lean().exec();
        if (item === null) {
            res.redirect('/'); // nie ma takiego itemu
        } else if (req.session.admin) {
            res.render('item-edit', { item, user: req.session.userid, admin: req.session.admin }); 
        } else {
            res.render('item', { item, user: req.session.userid, admin: req.session.admin });
        }
    });

    app.get('/new-item', upload.single(), (req, res) => {
        if (req.session.admin) {
            res.render('new-item', { user: req.session.userid, admin: req.session.admin });
        } else {
            res.redirect('/');
        }
        
    });

    /* TODO: admin-only endpoint */
    app.post('/new-item', upload.fields([
        { name: 'thumbnail', maxCount: 1 },
        { name: 'skin', maxCount: 1 }
    ]), async (req, res) => {
        const thumbnail = req.files.thumbnail[0];
        const skin = req.files.skin[0];

        const thumbnailB64 = fs.readFileSync(thumbnail.path, 'base64');
        const skinB64 = fs.readFileSync(skin.path, 'base64');

        // file deletion
        fs.unlinkSync(thumbnail.path);
        fs.unlinkSync(skin.path);

        if (null !== await Skin.findOne({ name: req.body.name }).exec()) {
            res.render('new-item', { message: 'Skin with such name already exists.', user: req.session.userid, admin: req.session.admin });
            return;
        }

        const newSkin = new Skin({
            name: req.body.name,
            thumbnail: thumbnailB64, // base64 generated from the uploaded file
            description: req.body.description,
            priceUsd: req.body.price,
            status: req.body.status == 'on'
        });

        // TODO:
        // the skin itself should land in a separate collection
        // under the same name as the Skin object

        await newSkin.save();
        res.redirect('/');
    });

    app.post('/edit/:name', upload.fields([  // chcialem zeby tutaj byl PUT, ale w html form nie ma :(
        { name: 'thumbnail', maxCount: 1 },
        { name: 'skin', maxCount: 1 }
    ]), async (req, res) => {
        let thumbnail;
        let skin;
        if (req.files.thumbnail) {
            thumbnail = fs.readFileSync(req.files.thumbnail[0].path, 'base64');
            fs.unlinkSync(req.files.thumbnail[0].path);
        }
        if (req.files.skin) {
            skin = fs.readFileSync(req.files.skin[0].path, 'base64');
            fs.unlinkSync(req.files.skin[0].path);
        }
        let item = await Skin.findOne({ name: req.params.name }).lean().exec();
        if (item === null) {
            res.render('item-edit', { item, message: 'Error', user: req.session.userid, admin: req.session.admin });
            return;
        }
        const checkName = await Skin.findOne({ name: req.body.name }).lean().exec();
        if (req.body.name !== req.params.name && checkName !== null) {
            res.render('item-edit', { item, message: 'Name is occupied', user: req.session.userid, admin: req.session.admin });
            return;
        }
        thumbnail = thumbnail || item.thumbnail;
        skin = skin || item.thumbnail;
        if (!thumbnail || !skin) {
            res.render('item-edit', { item, message: 'Missing skin and thumbnail', user: req.session.userid, admin: req.session.admin });
            return;
        }

        await Skin.findOneAndReplace({ name: req.params.name }, {
            name: req.body.name,
            thumbnail: thumbnail, // base64 generated from the uploaded file
            description: req.body.description,
            priceUsd: req.body.price,
            status: req.body.status == 'on'
        }).lean().exec();
        item = await Skin.findOne({ name: req.body.name }).lean().exec();

        res.render('item-edit', { item, message: 'Success', user: req.session.userid, admin: req.session.admin });
    });

    app.get('/login', auth, (req, res) => {
        if (req.session.userid) {
            res.redirect('/?message=' + 'Jesteś już zalogowany');
        } else {
            res.render('login');
        }
    });

    app.post('/login', auth, async (req, res) => {
        if (req.session.userid) {
            res.redirect('/?message=' + 'Jesteś już zalogowany');
        }
        
        const username = req.body.username;
        const password = createHash('sha256').update(req.body.password).digest('hex');
        const account = await User.findOne({ username }).lean().exec();

        if (account !== null && account.password === password) {
            let session = req.session;
            session.userid = username;
            session.admin = account.admin;
            res.redirect('/?message=' + 'Zalogowano');
        } else {
            res.render('login', { message: 'Invalid login or password.' });
        }
    });

    app.get('/register', auth, (req, res) => {
        if (req.session.userid) {
            res.redirect('/?message=' + 'Jesteś już zalogowany');
        } else {
            res.render('register');
        }
    });

    app.post('/register', upload.single(), auth, async (req, res) => {
        console.log(req.body);

        if (req.session.userid) {
            res.redirect('/?message=' + 'Jesteś już zalogowany');
        } else {
            if (req.body.password !== req.body.cpassword) {
                res.render('register', { message: 'Passwords are not matching.' });
                return;
            }

            if (null !== await User.findOne({ username: req.body.username }).exec()) {
                res.render('register', { message: 'Username taken.' });
                return;
            }
            if (null !== await User.findOne({ email: req.body.email }).exec()) {
                res.render('register', { message: 'Email taken.' });
                return;
            }

            const newUser = new User({
                name: req.body.name,
                username: req.body.username,
                email: req.body.email,
                password: createHash('sha256').update(req.body.password).digest('hex'),
                creationTime: new Date(),
                admin: false
            });

            await newUser.save();
            res.redirect('/?message=' + 'Konto zostało utworzone');
        }
    });

    app.get('/logout', auth, (req, res) => {  // chyba tymczasowo get 
        if (req.session.userid) {
            req.session.destroy();
        }
        res.redirect('/');
    });

    app.get('/admin', (req, res) => {
        if (req.session.admin) {
            res.render('admin', { user: req.session.userid, admin: req.session.admin }); // TODO
        } else {
            res.redirect('/');
        }
    });

    function auth(req, res, next) { // tu bedziemy sprawdzac middlewareowo czy ktos jest zalogowany i czy jest adminem
        if (req.session.userid) {
            req.logged = true;
        } else {
            req.logged = false;
        }
        next();
    }

    http.createServer(app).listen(3000, () => {
        console.log('Server is running on port 3000.');
    });
})();
