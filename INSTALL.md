# LiberShare - installation

These are the installation instruction for **Debian Linux** (logged in as root):

**1. Install system dependencies, download Bun and create the settings file**

```bash
apt update
apt -y upgrade
apt install curl unzip git mariadb-server mariadb-client
curl -fsSL https://bun.sh/install | bash
source /root/.bashrc
git clone https://github.com/libersoft-org/libershare.git
cd libershare/src
./start.sh --create-settings
```

**2. Edit the settings.json file**

```bash
nano settings.json
```

Here you need to set up:
- **web** section:
  - **standalone** - true / false
    - **true** means it will run a standalone web server with network port
    - **false** means you'll run it as a unix socket and connect it through other web server (**Nginx** is recommended)
  - **port** - your web server's network port (ignored if you're not running a standalone server)
  - **socket_path** - path to a unix socket file (ignored if you're running standalone server)
  - **socket_owner** - owner of a unix socket file
  - **session_user_lifetime** - for how long the web server keeps user's session (in seconds)
  - **session_admin_lifetime** - for how long the web server keeps admin's session (in seconds)
- **storage** section:
  - **upload** - the path where a sucessfully uploaded files are stored
  - **download** - the path for files that have been moved from upload path to a specific product
  - **images** - the path for product and categories image files
  - **temp** - the path for files that are in uploading process
- **database** section - the hostname, port, name, user and password to your MariaDB database
- **email** section:
  - credentials to your e-mail server: hostname, port, user, password and encryption (tls - true / false)
  - the e-mail address and visible name for the e-mails that system sends to users (registration e-mail, forgot password etc.)
- **other** section:
  - **log_to_file** - if you'd like to log to console and log file (true) or to console only (false)
  - **log_file** - the path to your log file (ignored if log_to_file is false)

**3. Set the NGINX site host config file**

The following applies only for unix socket server. Skip this step if you're running standalone server.

If you don't have your Nginx web server installed, run this command:

```bash
apt install nginx
```

In **/etc/nginx/sites-available/**, create the new config file named by your domain name, ending with ".conf" extension (e.g.: your-server.com.conf).

For example:

```bash
nano /etc/nginx/sites-available/your-server.com.conf
```

The example of NGINX site host config file:

```conf
server {
 listen 80;
 listen [::]:80;
 server_name libershare.com *.libershare.com;

 location / {
  proxy_pass http://server;
 }
}

upstream server {
 server unix:/run/libershare.sock;
}
```

Then restart the NGINX server:

```bash
service nginx restart
```

You can also add the HTTPS certificate using **certbot** if needed.

**4. Create the MariaDB user and grant privileges to your database**

```bash
mysql -u root -p
```

... after you log in set the database root password or create a new database user and grant it's privileges:

a) for **root**:

```sql
ALTER USER 'root'@'localhost' IDENTIFIED BY 'some_password';
```

b) for **other user**:

```sql
CREATE USER 'some_user'@'localhost' IDENTIFIED BY 'some_password';
GRANT ALL ON some_database.* TO 'some_user'@'localhost';
```

... after that exit the database simply by "**exit**" command.

**9. Create the database**

```bash
./start.sh --create-database
```

**10. Start the server application**

a) to start the server in **console** using **bun**:

```bash
./start.sh
```

b) to start the server in **console** by **bun** in **hot reload** (dev) mode:

```bash
./start-hot.sh
```

c) to start the server in **screen** by **bun**:

```bash
./start-screen.sh
```

d) to start the server in **screen** by **bun** in **hot reload** (dev) mode:

```bash
./start-hot-screen.sh
```

**11. Open the web browser and navigate to your website or web admin**

For example:
- User frontend: **https://your-server.com/**
- Web admin: **https://your-server.com/admin/**

Default admin credentials:
- User: **admin**
- Password: **admin**
