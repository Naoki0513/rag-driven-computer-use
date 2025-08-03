@echo off
REM Cypher Shell batch file for easy access to Neo4j database
REM Usage: cypher-shell.bat [cypher query]
REM Example: cypher-shell.bat "RETURN 1 AS test"

if "%~1"=="" (
    REM Interactive mode - start cypher-shell in interactive mode
    docker exec -it neo4j-crawler cypher-shell -u neo4j -p testpassword
) else (
    REM Non-interactive mode - execute the provided query
    docker exec neo4j-crawler cypher-shell -u neo4j -p testpassword %*
) 