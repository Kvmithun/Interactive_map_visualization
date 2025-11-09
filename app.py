# your_project/app.py (MODIFIED)

from flask import Flask, render_template

# Initialize the Flask application
app = Flask(__name__)

@app.route('/')
def index():
    """Renders the main landing page."""
    return render_template('index.html')

@app.route('/map')
def map_page():
    """Renders the map page with Leaflet."""
    return render_template('map.html')

# 👇 ADDED: NEW ROUTE FOR THE PROJECT GUIDE 👇
@app.route('/guide')
def project_guide():
    """Renders the 5-page project guide/documentation."""
    return render_template('guide.html')

if __name__ == '__main__':
    app.run(debug=True)