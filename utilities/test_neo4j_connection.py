import requests
from neo4j import GraphDatabase
import sys

NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

def test_http_endpoint():
    """HTTP接続をテスト"""
    try:
        print("🌐 Testing HTTP connection to Neo4j...")
        response = requests.get("http://localhost:7474/", timeout=5)
        print(f"✅ HTTP Status: {response.status_code}")
        if "neo4j" in response.text.lower():
            print("✅ Neo4j Web UI is accessible")
        else:
            print("⚠️ Response received but may not be Neo4j")
            
        # Browser endpoint test
        browser_response = requests.get("http://localhost:7474/browser/", timeout=5)
        print(f"✅ Browser endpoint status: {browser_response.status_code}")
        
    except requests.exceptions.ConnectionError:
        print("❌ HTTP connection failed - check if port 7474 is accessible")
    except requests.exceptions.Timeout:
        print("❌ HTTP connection timed out")
    except Exception as e:
        print(f"❌ HTTP error: {e}")

def test_bolt_connection():
    """Bolt接続をテスト"""
    try:
        print("\n🔌 Testing Bolt connection to Neo4j...")
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        
        with driver.session() as session:
            result = session.run("RETURN 'Hello Neo4j' as message")
            record = result.single()
            print(f"✅ Bolt connection successful: {record['message']}")
            
            # Check existing data
            count_result = session.run("MATCH (n) RETURN count(n) as nodeCount")
            node_count = count_result.single()['nodeCount']
            print(f"📊 Current nodes in database: {node_count}")
            
        driver.close()
        
    except Exception as e:
        print(f"❌ Bolt connection failed: {e}")

def test_windows_firewall():
    """Windows環境での一般的な問題をチェック"""
    print("\n🛡️ Windows network troubleshooting:")
    
    # Port accessibility check using netstat
    import subprocess
    try:
        result = subprocess.run(['netstat', '-an'], capture_output=True, text=True)
        if ':7474' in result.stdout:
            print("✅ Port 7474 is listening")
        else:
            print("❌ Port 7474 is not listening")
            
        if ':7687' in result.stdout:
            print("✅ Port 7687 is listening")
        else:
            print("❌ Port 7687 is not listening")
            
    except Exception as e:
        print(f"⚠️ Network check failed: {e}")

if __name__ == "__main__":
    print("🔍 Neo4j Connection Diagnostic Tool")
    print("="*50)
    
    test_http_endpoint()
    test_bolt_connection()
    test_windows_firewall()
    
    print("\n" + "="*50)
    print("📋 Manual Steps to Try:")
    print("1. Try accessing: http://127.0.0.1:7474")
    print("2. Try accessing: http://[::1]:7474")
    print("3. Check Windows Firewall settings")
    print("4. Try different browser (Chrome/Firefox/Edge)")
    print("5. Check antivirus software blocking")
    print("="*50) 