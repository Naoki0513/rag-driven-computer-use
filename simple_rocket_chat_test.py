import asyncio
import logging
from playwright.async_api import async_playwright

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TARGET_URL = "http://the-agent-company.com:3000"
LOGIN_USERNAME = "theagentcompany"
LOGIN_PASSWORD = "theagentcompany"

async def test_rocket_chat_login():
    """Simple test to verify Rocket.Chat login"""
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()
        
        # Enable console logging
        page.on("console", lambda msg: print(f"Console: {msg.text}"))
        
        logger.info("Step 1: Navigate to login page")
        await page.goto(TARGET_URL, wait_until='networkidle')
        await page.wait_for_timeout(3000)
        
        # Take screenshot
        await page.screenshot(path="test_1_login_page.png")
        
        logger.info("Step 2: Fill login form")
        # Fill username
        username_filled = False
        try:
            await page.fill('input[name="emailOrUsername"]', LOGIN_USERNAME)
            username_filled = True
            logger.info("Username filled")
        except:
            logger.error("Failed to fill username")
            
        # Fill password
        password_filled = False
        try:
            await page.fill('input[type="password"]', LOGIN_PASSWORD)
            password_filled = True
            logger.info("Password filled")
        except:
            logger.error("Failed to fill password")
            
        await page.screenshot(path="test_2_form_filled.png")
        
        logger.info("Step 3: Submit login")
        try:
            # Click login button
            await page.click('button.login')
            logger.info("Login button clicked")
        except:
            # Try alternative
            await page.press('input[type="password"]', 'Enter')
            logger.info("Pressed Enter to submit")
            
        # Wait for navigation
        logger.info("Step 4: Wait for login to complete")
        await page.wait_for_timeout(10000)
        
        current_url = page.url
        logger.info(f"Current URL: {current_url}")
        
        # Take screenshot
        await page.screenshot(path="test_3_after_login.png")
        
        # Check if we're logged in
        is_logged_in = await page.evaluate("""
            () => {
                // Look for Rocket.Chat main app elements
                const hasMainContent = !!(
                    document.querySelector('.main-content') ||
                    document.querySelector('.rc-old') ||
                    document.querySelector('[data-qa="home-body"]') ||
                    document.querySelector('.sidebar')
                );
                
                // Look for login form (indicates we're NOT logged in)
                const hasLoginForm = !!(
                    document.querySelector('input[name="emailOrUsername"]') ||
                    document.querySelector('.login-form')
                );
                
                return {
                    hasMainContent,
                    hasLoginForm,
                    url: window.location.href,
                    title: document.title,
                    bodyText: document.body.innerText.substring(0, 200)
                };
            }
        """)
        
        logger.info(f"Login check result: {is_logged_in}")
        
        if not is_logged_in['hasMainContent'] and is_logged_in['hasLoginForm']:
            logger.error("Still on login page - login failed")
            
            # Check for error messages
            error_msg = await page.evaluate("""
                () => {
                    const errorElements = document.querySelectorAll('.error, .alert-danger, [class*="error"]');
                    return Array.from(errorElements).map(e => e.textContent).join('; ');
                }
            """)
            
            if error_msg:
                logger.error(f"Error message: {error_msg}")
        else:
            logger.info("Login appears successful!")
            
            # Try to navigate to general channel
            logger.info("Step 5: Navigate to general channel")
            await page.goto(f"{TARGET_URL}/channel/general", wait_until='networkidle')
            await page.wait_for_timeout(5000)
            
            await page.screenshot(path="test_4_general_channel.png")
            logger.info(f"Final URL: {page.url}")
            
            # Get page structure
            structure = await page.evaluate("""
                () => {
                    const elements = {
                        sidebar: !!document.querySelector('.sidebar'),
                        channels: document.querySelectorAll('[data-qa*="sidebar-item"]').length,
                        messages: document.querySelectorAll('[data-qa="message"]').length,
                        mainContent: !!document.querySelector('.main-content'),
                        roomHeader: !!document.querySelector('.rc-room-header')
                    };
                    return elements;
                }
            """)
            
            logger.info(f"Page structure: {structure}")
            
        await browser.close()

if __name__ == "__main__":
    asyncio.run(test_rocket_chat_login())