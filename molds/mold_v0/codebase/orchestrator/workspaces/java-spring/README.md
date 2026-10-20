# inventory-service

Small inventory API (Spring Boot 3, Java 21, Maven).

```
./mvnw spring-boot:run     # or: mvn spring-boot:run   -> http://localhost:8080
mvn test
```

Endpoints: `GET /items`, `GET /items/{id}`, `POST /items`, `PATCH /items/{id}/quantity?delta=-2`.
Items are kept in memory (`ItemRepository`) for now and reset on restart.
