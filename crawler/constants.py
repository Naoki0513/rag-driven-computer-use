# constants.py
import logging

logger = logging.getLogger(__name__)

# Constants
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

TARGET_URL = "http://the-agent-company.com:3000/"
LOGIN_USER = "theagentcompany"
LOGIN_PASS = "theagentcompany"
MAX_STATES = 10000
MAX_DEPTH = 20
PARALLEL_TASKS = 8

MAX_HTML_SIZE = 100 * 1024
MAX_ARIA_CONTEXT_SIZE = 2 * 1024 