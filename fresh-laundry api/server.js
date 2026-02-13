const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const cors = require('cors');

// --- Configuration ---
const app = express();
const PORT = 3000;
const SECRET_KEY = 'your_super_secret_key';

// --- MySQL Connection Pool ---
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'fresh_laundry',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.use(cors());
app.use(express.json()); 
app.use(bodyParser.json());

// =======================================================
// === USER AUTHENTICATION ================================
// =======================================================

app.post('/api/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ message: 'Please provide name, email, and password.' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.execute(
            'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            [name, email, hashedPassword]
        );
        res.status(201).json({
            message: 'User registered successfully',
            user: { id: result.insertId, name, email }
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'User already exists.' });
        }
        res.status(500).json({ message: 'Registration failed.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        const user = rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: '1h' });
        res.json({
            message: 'Login successful',
            token,
            user: { id: user.id, name: user.name, email: user.email }
        });
    } catch (error) {
        res.status(500).json({ message: 'Login failed' });
    }
});

// =======================================================
// === ORDERS ============================================
// =======================================================

app.post('/api/place_order', async (req, res) => {
    const { user_id, pickup_date, pickup_time, delivery_option, total_price, items } = req.body;
    
    if (!items || items.length === 0) {
        return res.status(400).json({ message: 'Cannot place an empty order.' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Insert into orders table
        const [orderResult] = await connection.execute(
            `INSERT INTO orders (user_id, pickup_date, pickup_time, delivery_option, total_price, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [user_id, pickup_date, pickup_time, delivery_option, total_price, 'pending']
        );
        const orderId = orderResult.insertId;

        // 2. Prepare item values
        const itemValues = items.map(item => [
            orderId, 
            item.categoryId || 1, 
            item.id, 
            item.title, 
            item.quantity, 
            item.pricePerUnit
        ]);

        // 3. Insert items
        await connection.query(
            `INSERT INTO order_items (order_id, category_id, item_id, item_name, quantity, price_per_unit) VALUES ?`,
            [itemValues]
        );

        await connection.commit();
        res.status(201).json({ message: 'Order placed successfully', orderId });

    } catch (error) {
        // --- DETAILED ERROR CATCH ---
        await connection.rollback();
        
        console.error("\n❌ --- ORDER TRANSACTION FAILED ---");
        console.error("Error Code:", error.code);
        console.error("SQL Message:", error.sqlMessage || error.message);
        console.error("------------------------------------\n");

        res.status(500).json({ 
            message: 'Failed to place order. Database rollback occurred.',
            error: error.sqlMessage || error.message 
        });
    } finally {
        connection.release();
    }
});

app.get('/api/orders', async (req, res) => {
    try {
        const [orders] = await pool.execute(`
            SELECT orders.*, users.name AS client_name 
            FROM orders 
            JOIN users ON orders.user_id = users.id 
            ORDER BY orders.created_at DESC
        `);

        for (let order of orders) {
            const [items] = await pool.execute(
                'SELECT item_name as title, quantity, price_per_unit as pricePerUnit FROM order_items WHERE order_id = ?',
                [order.id]
            );
            order.items = items;
        }

        res.json(orders);
    } catch (error) {
        console.error("FETCH ERROR:", error);
        res.status(500).json({ message: 'Failed to fetch orders' });
    }
});

app.get('/api/orders/:id', async (req, res) => {
    const orderId = req.params.id;
    try {
        const [orders] = await pool.execute(`
            SELECT orders.*, users.name AS client_name 
            FROM orders 
            JOIN users ON orders.user_id = users.id 
            WHERE orders.id = ?`, 
            [orderId]
        );

        if (orders.length === 0) return res.status(404).json({ message: 'Order not found' });

        const order = orders[0];
        const [items] = await pool.execute(
            'SELECT item_name, quantity, price_per_unit FROM order_items WHERE order_id = ?',
            [orderId]
        );
        order.items = items;
        res.json(order);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch order' });
    }
});

app.put('/api/orders/:id/status', async (req, res) => {
    const orderId = req.params.id;
    const { status } = req.body;
    const allowedStatuses = ['pending', 'in wash', 'finished', 'cancelled'];

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid status value' });
    }

    try {
        const [result] = await pool.execute(
            'UPDATE orders SET status = ? WHERE id = ?',
            [status, orderId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Order not found' });
        }

        res.json({ success: true, message: `Order status updated to ${status}` });
    } catch (error) {
        console.error("Update Error:", error);
        res.status(500).json({ message: 'Failed to update order status' });
    }
});

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [statusCounts] = await pool.execute(`
            SELECT status, COUNT(*) as count 
            FROM orders 
            GROUP BY status
        `);

        const [revenue] = await pool.execute(`
            SELECT SUM(total_price) as total 
            FROM orders 
            WHERE status != 'cancelled'
        `);

        const stats = {
            pending: 0,
            in_wash: 0,
            finished: 0,
            total_revenue: revenue[0].total || 0
        };

        statusCounts.forEach(row => {
            if (row.status === 'pending') stats.pending = row.count;
            if (row.status === 'in wash') stats.in_wash = row.count;
            if (row.status === 'finished') stats.finished = row.count;
        });

        res.json(stats);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch stats' });
    }
});

// =======================================================
// === ADMIN AUTHENTICATION ==============================
// =======================================================

// ADMIN LOGIN
app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        // Query the 'admins' table instead of 'users'
        const [rows] = await pool.execute('SELECT * FROM admins WHERE email = ?', [email]);
        const admin = rows[0];

        if (!admin || !(await bcrypt.compare(password, admin.password))) {
            return res.status(401).json({ message: 'Invalid admin credentials' });
        }

        // We add "role: admin" to the token payload for security
        const token = jwt.sign(
            { id: admin.id, email: admin.email, role: 'admin' }, 
            SECRET_KEY, 
            { expiresIn: '2h' }
        );

        res.json({
            message: 'Admin login successful',
            token,
            admin: { id: admin.id, name: admin.name, email: admin.email }
        });
    } catch (error) {
        console.error("ADMIN LOGIN ERROR:", error);
        res.status(500).json({ message: 'Admin login failed' });
    }
});

// =======================================================
// === ADMIN REGISTRATION ================================
// =======================================================

app.post('/api/admin/register', async (req, res) => {
    const { name, email, password } = req.body;

    // 1. Validation
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Please provide name, email, and password.' });
    }

    try {
        // 2. Hash the password (matches your user register logic)
        const hashedPassword = await bcrypt.hash(password, 10);

        // 3. Insert into 'admins' table
        const [result] = await pool.execute(
            'INSERT INTO admins (name, email, password) VALUES (?, ?, ?)',
            [name, email, hashedPassword]
        );

        // 4. Respond with success
        res.status(201).json({
            message: 'Admin registered successfully',
            admin: { id: result.insertId, name, email }
        });

    } catch (error) {
        // Handle duplicate admin emails
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Admin email already exists.' });
        }
        
        console.error("ADMIN REGISTRATION ERROR:", error);
        res.status(500).json({ message: 'Admin registration failed.' });
    }
});

// // Add this to your server.js or routes file
// app.patch('/api/orders/:id', (req, res) => {
//     const orderId = req.params.id;
//     const { status } = req.body;

//     const query = "UPDATE orders SET status = ? WHERE id = ?";
    
//     db.query(query, [status, orderId], (err, result) => {
//         if (err) {
//             return res.status(500).json({ error: err.message });
//         }
//         res.json({ message: "Order status updated successfully" });
//     });
// });

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Fresh Laundry Server running on http://localhost:${PORT}`);
});